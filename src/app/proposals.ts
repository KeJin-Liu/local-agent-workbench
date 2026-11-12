/**
 * 模型提案。确认前只留草稿；确认时整笔写入，失败则本体不落库。
 * p1.4：扩展 provider / app_settings / friend_patch / group / vault_binding。
 * session_prefs（会话模式/推理/模型）本包后置。
 */

import type {
  AppSettings,
  AutomationTask,
  Conversation,
  Friend,
  MailInstructionSettings,
  McpServer,
  Proposal,
  ProposalKind,
  Provider,
  SettingScope,
  Skill,
  VaultSecretRecord,
  WorkbenchDocument,
} from '../domain/types.ts'
import { DEFAULT_FRIEND_AVATAR } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import {
  clampSendWaitSeconds,
  normalizeAppSettings,
  normalizeMailSettings,
  normalizePlanModePrompt,
  normalizeSkillExtractPrompt,
} from '../storage/schema.ts'
import type { VaultService } from '../vault/service.ts'
import { AppError } from './errors.ts'
import { resolveGroupLineage } from './mcp.ts'
import { normalizeBaseUrl } from './providers.ts'

export type ProposalDraft = {
  conversationId: string
  kind: ProposalKind
  name: string
  summary?: string
  draft?: Record<string, unknown>
}

const PROPOSE_NAME = 'workbench_propose'
const CONFIG_GET_NAME = 'workbench_get_config'

const LEGACY_KINDS: ProposalKind[] = ['skill', 'mcp', 'task', 'friend']
const CONFIG_KINDS: ProposalKind[] = ['provider', 'app_settings', 'friend_patch', 'group', 'vault_binding']
const ALL_KINDS: ProposalKind[] = [...LEGACY_KINDS, ...CONFIG_KINDS]

export function isProposalKind(value: unknown): value is ProposalKind {
  return typeof value === 'string' && (ALL_KINDS as string[]).includes(value)
}

export function isConfigProposalKind(kind: ProposalKind): boolean {
  return (CONFIG_KINDS as string[]).includes(kind)
}

/** 卡面/摘要用：保留末四位，前面打点。 */
export function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

/** 交给模型的内置工具。调用它只创建确认卡。 */
export const PROPOSE_TOOL = {
  type: 'function' as const,
  function: {
    name: PROPOSE_NAME,
    description:
      '提议写入配置或新建实体，只生成确认卡；用户确认前不会保存。' +
      'kind=skill|mcp|task|friend 为原有创建；' +
      'kind=provider 新建/更新提供方（Key 走保险库）；' +
      'kind=app_settings 补丁应用设置（sendWaitSeconds/planModePrompt/skillExtractPrompt/mailInstructions）；' +
      'kind=friend_patch 更新已有好友（需 friendId）；' +
      'kind=group 新建群或改成员；' +
      'kind=vault_binding 创建保险库条目并绑到提供方/邮箱。' +
      '会话级 composer（模式/推理/模型）请后置，不要用本工具冒充。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'skill',
            'mcp',
            'task',
            'friend',
            'provider',
            'app_settings',
            'friend_patch',
            'group',
            'vault_binding',
          ],
        },
        name: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string' },
        description: { type: 'string' },
        systemPrompt: { type: 'string' },
        friendId: { type: 'string' },
        friendIds: { type: 'array', items: { type: 'string' } },
        schedule: { type: 'string', enum: ['manual', 'cron'] },
        cron: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'sse', 'http'] },
        command: { type: 'string' },
        url: { type: 'string' },
        providerId: { type: 'string' },
        model: { type: 'string', description: '好友默认模型 id（kind=friend）；写入 Friend.defaultModelId' },
        defaultModelId: { type: 'string', description: '同 model，优先用这个字段名' },
        id: { type: 'string', description: '更新已有提供方/群会话时填 id' },
        baseUrl: { type: 'string' },
        apiKey: { type: 'string', description: '仅用于确认后写入保险库；卡片会脱敏，不进聊天明文历史' },
        vaultEntryId: { type: 'string' },
        enabled: { type: 'boolean' },
        defaultModel: { type: 'string' },
        sendWaitSeconds: { type: 'number' },
        planModePrompt: { type: 'string' },
        skillExtractPrompt: { type: 'string' },
        mailInstructions: { type: 'object' },
        workspacePath: { type: 'string' },
        title: { type: 'string' },
        conversationId: { type: 'string', description: '改群成员时填群会话 id' },
        action: { type: 'string', enum: ['create', 'add_members', 'update'], description: 'group 动作' },
        secretKind: { type: 'string', enum: ['api-key', 'login'] },
        password: { type: 'string' },
        username: { type: 'string' },
        bindTarget: {
          type: 'string',
          enum: ['provider', 'mail_imap', 'mail_smtp'],
          description: 'vault_binding 绑到哪里',
        },
      },
      required: ['kind', 'name'],
    },
  },
}

/** 只读：拿当前配置摘要，再提议 patch。不落库、不改设置。 */
export const CONFIG_GET_TOOL = {
  type: 'function' as const,
  function: {
    name: CONFIG_GET_NAME,
    description:
      '读取当前工作台配置摘要（提供方/应用设置/好友要点/群列表），不含密钥明文。改配置前先调用，再 workbench_propose。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'providers', 'app_settings', 'friends', 'groups'],
          description: '缺省 all',
        },
      },
    },
  },
}

export function createProposalService(database: WorkbenchDatabase, vault?: VaultService) {
  return {
    toolName: PROPOSE_NAME,
    configGetToolName: CONFIG_GET_NAME,

    async listPending(conversationId: string): Promise<Proposal[]> {
      return (await database.read()).stores.proposals.filter(
        (item) => item.conversationId === conversationId && item.status === 'pending',
      )
    },

    async getConfigSummary(section: string = 'all'): Promise<string> {
      return summarizeConfigForModel(await database.read(), section)
    },

    async stage(input: ProposalDraft): Promise<Proposal> {
      const name = input.name.trim()
      if (!name) throw new AppError(400, '提案名称不能为空。')
      if (!isProposalKind(input.kind)) throw new AppError(400, '提案类型不正确。')
      const rawDraft = { ...(input.draft ?? {}) }
      const draft = await sanitizeDraftForStage(input.kind, rawDraft, name, vault)
      validateStageDraft(input.kind, name, draft)
      const now = Date.now()
      const proposal: Proposal = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        kind: input.kind,
        name,
        summary: buildSummary(input.kind, name, input.summary, draft),
        draft,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      await database.update((document) => {
        document.stores.proposals.push(proposal)
      })
      log('info', 'proposals', '出示确认卡', { id: proposal.id, kind: proposal.kind, conversationId: proposal.conversationId })
      return proposal
    },

    async confirm(
      id: string,
      scope: SettingScope | 'groups',
      friendIds: string[] = [],
      fields: {
        name?: string
        summary?: string
        systemPrompt?: string
        description?: string
        defaultModelId?: string
      } = {},
      groupIds: string[] = [],
    ): Promise<Proposal> {
      const chosen = [...new Set(friendIds.map((item) => item.trim()).filter(Boolean))]
      const chosenGroups = [...new Set(groupIds.map((item) => item.trim()).filter(Boolean))]
      if (scope !== 'global' && scope !== 'friends' && scope !== 'groups') throw new AppError(400, '作用域不正确。')
      try {
        const saved = await database.update((document) => {
          const proposal = document.stores.proposals.find((item) => item.id === id)
          if (!proposal || proposal.status !== 'pending') throw new AppError(400, '这张确认卡已经结束。')
          if (fields.name !== undefined) {
            const nextName = fields.name.trim()
            proposal.name = nextName
            proposal.draft = { ...proposal.draft, name: nextName }
          }
          if (fields.summary !== undefined) {
            proposal.summary = fields.summary.trim() || proposal.name
          }
          if (fields.systemPrompt !== undefined) {
            proposal.draft = { ...proposal.draft, systemPrompt: fields.systemPrompt }
          }
          if (fields.description !== undefined) {
            proposal.draft = { ...proposal.draft, description: fields.description }
          }
          if (fields.defaultModelId !== undefined) {
            proposal.draft = { ...proposal.draft, defaultModelId: fields.defaultModelId }
          }

          if (isConfigProposalKind(proposal.kind)) {
            writeConfigKind(document, proposal)
            proposal.status = 'confirmed'
            proposal.scope = 'global'
            delete proposal.error
            proposal.updatedAt = Date.now()
            return proposal
          }

          if (scope === 'groups') {
            if (proposal.kind !== 'mcp') throw new AppError(400, '只有 MCP 可以挂到指定群。')
            if (chosenGroups.length === 0) throw new AppError(400, '指定群聊时至少选一个。')
            const resolvedGroups = chosenGroups.map((groupId) => resolveGroupLineage(document.stores.conversations, groupId))
            if (resolvedGroups.some((groupId) => !groupId)) throw new AppError(400, '指定的群不存在，没有写入。')
            const lineages = [...new Set(resolvedGroups.filter((groupId): groupId is string => Boolean(groupId)))]
            writeMcp(document.stores, proposal, 'groups', undefined, lineages)
            proposal.status = 'confirmed'
            proposal.scope = 'groups'
            proposal.groupIds = lineages
            delete proposal.friendIds
            delete proposal.error
            proposal.updatedAt = Date.now()
            return proposal
          }

          if (scope === 'friends' && chosen.length === 0) throw new AppError(400, '指定好友时至少选一个。')
          if (scope === 'friends' && chosen.some((friendId) => !document.stores.friends.some((item) => item.id === friendId))) {
            throw new AppError(400, '指定的好友不存在，没有写入。')
          }
          const visible = scope === 'friends' ? chosen : undefined
          if (proposal.kind === 'friend') writeFriend(document.stores, proposal)
          else if (proposal.kind === 'task') writeTask(document.stores, proposal, scope, visible)
          else if (proposal.kind === 'skill') writeSkill(document.stores, proposal, scope, visible)
          else writeMcp(document.stores, proposal, scope, visible)
          proposal.status = 'confirmed'
          proposal.scope = proposal.kind === 'friend' ? 'global' : scope
          if (visible) proposal.friendIds = visible
          else delete proposal.friendIds
          delete proposal.groupIds
          delete proposal.error
          proposal.updatedAt = Date.now()
          return proposal
        })
        log('info', 'proposals', '确认落库', { id, kind: saved.kind, scope: saved.scope ?? scope })
        return saved
      } catch (error) {
        const message = error instanceof Error ? error.message : '确认失败'
        await database.update((document) => {
          const proposal = document.stores.proposals.find((item) => item.id === id)
          if (proposal && proposal.status === 'pending') {
            proposal.error = message
            proposal.updatedAt = Date.now()
          }
        })
        log('warn', 'proposals', '确认失败，未写入本体', { id, error: message })
        throw error instanceof AppError ? error : new AppError(400, message)
      }
    },

    async cancel(id: string): Promise<void> {
      await database.update((document) => {
        const proposal = document.stores.proposals.find((item) => item.id === id)
        if (!proposal || proposal.status !== 'pending') throw new AppError(400, '这张确认卡已经结束。')
        document.stores.proposals = document.stores.proposals.filter((item) => item.id !== id)
      })
      log('info', 'proposals', '取消并丢弃草稿', { id })
    },
  }
}

async function sanitizeDraftForStage(
  kind: ProposalKind,
  draft: Record<string, unknown>,
  proposalName: string,
  vault: VaultService | undefined,
): Promise<Record<string, unknown>> {
  const next = { ...draft }
  const apiKey = stringField(next, 'apiKey')
  const password = stringField(next, 'password')

  if ((kind === 'provider' || kind === 'vault_binding') && (apiKey || password)) {
    if (!vault) throw new AppError(400, '保存密钥需要保险库。')
    const secretKind = stringField(next, 'secretKind') === 'login' ? 'login' : 'api-key'
    const secretName =
      stringField(next, 'secretName') ||
      (kind === 'provider' ? `${stringField(next, 'name') || proposalName} 的密钥` : proposalName)
    if (secretKind === 'api-key' && !apiKey) throw new AppError(400, 'API Key 不能为空。')
    if (secretKind === 'login' && !password) throw new AppError(400, '密码不能为空。')
    const staged = await vault.stage({
      name: secretName,
      kind: secretKind,
      ...(stringField(next, 'username') ? { username: stringField(next, 'username') } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(password ? { password } : {}),
    })
    next.stagedSecret = staged
    if (apiKey) next.apiKeyMasked = maskSecret(apiKey)
    if (password) next.passwordMasked = maskSecret(password)
    delete next.apiKey
    delete next.password
  }

  // 兜底：任何 kind 都不该把明文 key 留在 draft
  if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
    next.apiKeyMasked = maskSecret(next.apiKey)
    delete next.apiKey
  }
  if (typeof next.password === 'string' && next.password.trim()) {
    next.passwordMasked = maskSecret(next.password)
    delete next.password
  }
  return next
}

function validateStageDraft(kind: ProposalKind, name: string, draft: Record<string, unknown>): void {
  if (kind === 'provider') {
    const baseUrl = stringField(draft, 'baseUrl')
    if (!baseUrl && !stringField(draft, 'id') && !stringField(draft, 'providerId')) {
      // 新建必须有 baseUrl；更新已有可省略（确认时用已有）
      throw new AppError(400, '提供方需要 Base URL。')
    }
    if (baseUrl) {
      try {
        normalizeBaseUrl(baseUrl)
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(400, 'Base URL 不正确。')
      }
    }
    return
  }
  if (kind === 'app_settings') {
    const hasPatch =
      draft.sendWaitSeconds !== undefined ||
      draft.planModePrompt !== undefined ||
      draft.skillExtractPrompt !== undefined ||
      draft.mailInstructions !== undefined
    if (!hasPatch) throw new AppError(400, '应用设置提案缺少可写入的字段。')
    if (draft.sendWaitSeconds !== undefined) {
      const n = Number(draft.sendWaitSeconds)
      if (!Number.isFinite(n) || n < 1 || n > 10) {
        throw new AppError(400, '发送等待秒数需要是 1–10 的整数。')
      }
    }
    return
  }
  if (kind === 'friend_patch') {
    if (!stringField(draft, 'friendId')) throw new AppError(400, '改好友需要 friendId。')
    const hasPatch =
      draft.systemPrompt !== undefined ||
      draft.workspacePath !== undefined ||
      draft.defaultModelId !== undefined ||
      draft.model !== undefined ||
      draft.description !== undefined ||
      draft.providerId !== undefined ||
      draft.name !== undefined ||
      draft.codePermission !== undefined
    if (!hasPatch) throw new AppError(400, '好友补丁缺少可写入的字段。')
    return
  }
  if (kind === 'group') {
    const action = stringField(draft, 'action') || 'create'
    const friendIds = stringArrayField(draft, 'friendIds')
    if (action === 'create') {
      if (friendIds.length < 2) throw new AppError(400, '建群至少要两个好友。')
      return
    }
    if (!stringField(draft, 'conversationId') && !stringField(draft, 'id')) {
      throw new AppError(400, '改群需要 conversationId。')
    }
    if (friendIds.length === 0 && action === 'add_members') {
      throw new AppError(400, '加成员时 friendIds 不能为空。')
    }
    return
  }
  if (kind === 'vault_binding') {
    const bindTarget = stringField(draft, 'bindTarget') || 'provider'
    if (bindTarget !== 'provider' && bindTarget !== 'mail_imap' && bindTarget !== 'mail_smtp') {
      throw new AppError(400, '保险库绑定目标不正确。')
    }
    if (bindTarget === 'provider' && !stringField(draft, 'providerId') && !stringField(draft, 'id')) {
      throw new AppError(400, '绑到提供方时需要 providerId。')
    }
    if (!draft.stagedSecret && !stringField(draft, 'vaultEntryId')) {
      throw new AppError(400, '保险库绑定需要密钥内容或已有 vaultEntryId。')
    }
    return
  }
  void name
}

function buildSummary(
  kind: ProposalKind,
  name: string,
  summary: string | undefined,
  draft: Record<string, unknown>,
): string {
  const given = (summary ?? '').trim()
  if (given) return given
  if (kind === 'app_settings') return diffAppSettingsSummary(draft)
  if (kind === 'provider') {
    const masked = stringField(draft, 'apiKeyMasked')
    const base = stringField(draft, 'baseUrl')
    const parts = [name]
    if (base) parts.push(base)
    if (masked) parts.push(`Key ${masked}`)
    return parts.join(' · ')
  }
  if (kind === 'friend_patch') return `更新好友 · ${stringField(draft, 'friendId') || name}`
  if (kind === 'group') {
    const action = stringField(draft, 'action') || 'create'
    return action === 'create' ? `新建群 · ${name}` : `改群成员 · ${name}`
  }
  if (kind === 'vault_binding') {
    const masked = stringField(draft, 'apiKeyMasked') || stringField(draft, 'passwordMasked')
    return masked ? `${name} · ${masked}` : name
  }
  return name
}

export function diffAppSettingsSummary(draft: Record<string, unknown>): string {
  const parts: string[] = []
  if (draft.sendWaitSeconds !== undefined) parts.push(`发送等待 → ${draft.sendWaitSeconds}s`)
  if (draft.planModePrompt !== undefined) {
    const text = String(draft.planModePrompt)
    parts.push(`计划提示词 → ${text.trim().slice(0, 40)}${text.trim().length > 40 ? '…' : ''}`)
  }
  if (draft.skillExtractPrompt !== undefined) {
    const text = String(draft.skillExtractPrompt)
    parts.push(`抽技能提示词 → ${text.trim().slice(0, 40)}${text.trim().length > 40 ? '…' : ''}`)
  }
  if (draft.mailInstructions !== undefined && draft.mailInstructions && typeof draft.mailInstructions === 'object') {
    const mail = draft.mailInstructions as Record<string, unknown>
    if (mail.enabled !== undefined) parts.push(`邮箱通道 → ${mail.enabled ? '开' : '关'}`)
    if (Array.isArray(mail.whitelist)) parts.push(`白名单 → ${mail.whitelist.length} 条`)
    if (mail.pollIntervalMinutes !== undefined) parts.push(`轮询 → ${mail.pollIntervalMinutes} 分`)
    if (mail.imap || mail.smtp) parts.push('邮箱端点有改动')
  }
  return parts.length ? parts.join('；') : '应用设置补丁'
}

function writeConfigKind(document: WorkbenchDocument, proposal: Proposal): void {
  if (proposal.kind === 'provider') writeProvider(document, proposal)
  else if (proposal.kind === 'app_settings') writeAppSettings(document, proposal)
  else if (proposal.kind === 'friend_patch') writeFriendPatch(document.stores, proposal)
  else if (proposal.kind === 'group') writeGroup(document.stores, proposal)
  else if (proposal.kind === 'vault_binding') writeVaultBinding(document, proposal)
  else throw new AppError(400, '提案类型不正确。')
}

function writeProvider(document: WorkbenchDocument, proposal: Proposal): void {
  const stores = document.stores
  const draft = proposal.draft
  const id = stringField(draft, 'id') || stringField(draft, 'providerId')
  const existing = id ? stores.providers.find((item) => item.id === id) : undefined
  if (id && !existing) throw new AppError(400, '要更新的提供方不存在，没有写入。')

  const name = (stringField(draft, 'name') || proposal.name || existing?.name || '').trim()
  if (!name) throw new AppError(400, '提供方名称不能为空，没有写入。')

  let baseUrl = stringField(draft, 'baseUrl') || existing?.baseUrl || ''
  if (!baseUrl) throw new AppError(400, '提供方需要 Base URL，没有写入。')
  baseUrl = normalizeBaseUrl(baseUrl)

  let vaultEntryId = stringField(draft, 'vaultEntryId') || existing?.vaultEntryId || ''
  const staged = draft.stagedSecret as VaultSecretRecord | undefined
  if (staged && typeof staged === 'object' && typeof staged.id === 'string' && typeof staged.ciphertext === 'string') {
    upsertSecretRecord(stores, staged)
    vaultEntryId = staged.id
  }

  const policy = existing?.apiKeyPolicy ?? 'optional'
  const enabled =
    draft.enabled === undefined ? (existing?.enabled ?? policy !== 'required') : Boolean(draft.enabled)
  if (enabled && policy === 'required' && !vaultEntryId) {
    throw new AppError(400, '这个提供方需要 API Key。粘贴一把，或选择一条保险库记录，然后再启用。')
  }

  const defaultModel =
    draft.defaultModel !== undefined
      ? stringField(draft, 'defaultModel') || undefined
      : existing?.defaultModel

  const now = Date.now()
  const provider: Provider = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    kind: 'openai-compatible',
    apiKeyPolicy: policy,
    enabled,
    baseUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(vaultEntryId ? { vaultEntryId } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(existing?.probedModels?.length ? { probedModels: [...existing.probedModels] } : {}),
  }

  if (existing) {
    const index = stores.providers.findIndex((item) => item.id === existing.id)
    stores.providers[index] = provider
  } else {
    stores.providers.push(provider)
  }

  // 卡面草稿去掉密文，只留脱敏与引用
  proposal.draft = {
    ...draft,
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(provider.vaultEntryId ? { vaultEntryId: provider.vaultEntryId } : {}),
    ...(typeof draft.apiKeyMasked === 'string' ? { apiKeyMasked: draft.apiKeyMasked } : {}),
  }
  delete proposal.draft.stagedSecret
  delete proposal.draft.apiKey
  delete proposal.draft.password
}

function writeAppSettings(document: WorkbenchDocument, proposal: Proposal): void {
  const draft = proposal.draft
  const current = normalizeAppSettings(document.settings)
  const mailPatch =
    draft.mailInstructions !== undefined && draft.mailInstructions && typeof draft.mailInstructions === 'object'
      ? (draft.mailInstructions as Partial<MailInstructionSettings>)
      : undefined

  let nextMail = current.mailInstructions
  if (mailPatch) {
    nextMail = normalizeMailSettings({
      ...current.mailInstructions,
      ...mailPatch,
      imap: mailPatch.imap
        ? { ...current.mailInstructions.imap, ...mailPatch.imap }
        : current.mailInstructions.imap,
      smtp: mailPatch.smtp
        ? { ...current.mailInstructions.smtp, ...mailPatch.smtp }
        : current.mailInstructions.smtp,
      whitelist: mailPatch.whitelist !== undefined ? mailPatch.whitelist : current.mailInstructions.whitelist,
    })
  }

  const next: AppSettings = normalizeAppSettings({
    sendWaitSeconds:
      draft.sendWaitSeconds !== undefined ? clampSendWaitSeconds(draft.sendWaitSeconds) : current.sendWaitSeconds,
    mailInstructions: nextMail,
    planModePrompt:
      draft.planModePrompt !== undefined ? normalizePlanModePrompt(draft.planModePrompt) : current.planModePrompt,
    skillExtractPrompt:
      draft.skillExtractPrompt !== undefined
        ? normalizeSkillExtractPrompt(draft.skillExtractPrompt)
        : current.skillExtractPrompt,
  })
  document.settings = next
  proposal.summary = diffAppSettingsSummary({
    ...(draft.sendWaitSeconds !== undefined ? { sendWaitSeconds: next.sendWaitSeconds } : {}),
    ...(draft.planModePrompt !== undefined ? { planModePrompt: next.planModePrompt } : {}),
    ...(draft.skillExtractPrompt !== undefined ? { skillExtractPrompt: next.skillExtractPrompt } : {}),
    ...(mailPatch ? { mailInstructions: next.mailInstructions } : {}),
  })
}

function writeFriendPatch(
  stores: { friends: Friend[]; providers: { id: string }[] },
  proposal: Proposal,
): void {
  const friendId = stringField(proposal.draft, 'friendId')
  const friend = stores.friends.find((item) => item.id === friendId)
  if (!friend) throw new AppError(400, '要更新的好友不存在，没有写入。')

  if (proposal.draft.enabled !== undefined) {
    throw new AppError(400, '好友暂不支持启停字段，请改系统提示词或工作目录等。')
  }

  const draft = proposal.draft
  if (draft.name !== undefined) {
    const nextName = stringField(draft, 'name')
    if (!nextName) throw new AppError(400, '好友名称不能为空，没有写入。')
    if (stores.friends.some((item) => item.id !== friend.id && item.name === nextName)) {
      throw new AppError(400, `已有同名好友「${nextName}」，没有写入。`)
    }
    friend.name = nextName
  }
  if (draft.description !== undefined) friend.description = stringField(draft, 'description')
  if (draft.systemPrompt !== undefined) friend.systemPrompt = String(draft.systemPrompt)
  if (draft.providerId !== undefined) {
    const providerId = stringField(draft, 'providerId')
    if (!providerId || !stores.providers.some((item) => item.id === providerId)) {
      throw new AppError(400, '好友绑定的提供方不存在，没有写入。')
    }
    friend.providerId = providerId
  }
  if (draft.defaultModelId !== undefined || draft.model !== undefined) {
    const model = stringField(draft, 'defaultModelId') || stringField(draft, 'model')
    if (model) friend.defaultModelId = model
    else delete friend.defaultModelId
  }
  if (draft.workspacePath !== undefined) {
    const pathValue = stringField(draft, 'workspacePath')
    if (pathValue) friend.workspacePath = pathValue
    else delete friend.workspacePath
  }
  if (draft.codePermission !== undefined) {
    const value = draft.codePermission
    if (value === null || value === '') {
      delete friend.codePermission
    } else if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
      friend.codePermission = value
    } else {
      throw new AppError(400, '编码权限不正确，没有写入。')
    }
  }
  friend.updatedAt = Date.now()
  proposal.name = friend.name
}

function writeGroup(
  stores: {
    friends: Friend[]
    providers: Provider[]
    conversations: Conversation[]
  },
  proposal: Proposal,
): void {
  const action = stringField(proposal.draft, 'action') || 'create'
  const requested = stringArrayField(proposal.draft, 'friendIds')
  const known = new Set(stores.friends.map((item) => item.id))
  const friendIds = [...new Set(requested)].filter((id) => known.has(id))

  if (action === 'create') {
    if (friendIds.length < 2) throw new AppError(400, '建群至少要两个好友，没有写入。')
    const title = (stringField(proposal.draft, 'title') || proposal.name).trim()
    if (!title) throw new AppError(400, '群名称不能为空，没有写入。')
    const primary = stores.friends.find((item) => item.id === friendIds[0])
    const provider =
      stores.providers.find((item) => item.id === primary?.providerId && item.enabled) ||
      stores.providers.find((item) => item.enabled) ||
      stores.providers[0]
    if (!provider) throw new AppError(400, '没有可用的提供方，没有写入群。')
    const now = Date.now()
    const id = crypto.randomUUID()
    const model = stringField(proposal.draft, 'model') || primary?.defaultModelId || provider.defaultModel
    const conversation: Conversation = {
      id,
      title,
      kind: 'group',
      friendIds,
      providerId: primary?.providerId || provider.id,
      lineageId: id,
      createdAt: now,
      updatedAt: now,
      ...(model ? { model } : {}),
    }
    stores.conversations.push(conversation)
    proposal.draft = { ...proposal.draft, conversationId: id, friendIds, action: 'create' }
    return
  }

  const conversationId = stringField(proposal.draft, 'conversationId') || stringField(proposal.draft, 'id')
  const current = stores.conversations.find((item) => item.id === conversationId)
  if (!current) throw new AppError(400, '要改的群不存在，没有写入。')
  if (current.kind !== 'group') throw new AppError(400, '只有群聊可以从这里改，没有写入。')

  let nextFriends = [...current.friendIds]
  if (action === 'add_members') {
    if (friendIds.length === 0) throw new AppError(400, '加成员时 friendIds 不能为空，没有写入。')
    nextFriends = [...new Set([...nextFriends, ...friendIds])]
  } else {
    // update：替换成员列表（可兼改名）
    if (friendIds.length > 0) nextFriends = friendIds
  }
  if (nextFriends.length < 2) throw new AppError(400, '群聊至少要两个好友，没有写入。')
  if (nextFriends.some((id) => !known.has(id))) throw new AppError(400, '成员里有不存在的好友，没有写入。')

  const title = (stringField(proposal.draft, 'title') || stringField(proposal.draft, 'name') || current.title).trim()
  if (!title) throw new AppError(400, '群名称不能为空，没有写入。')
  current.title = title
  current.friendIds = nextFriends
  current.updatedAt = Date.now()
  const model = stringField(proposal.draft, 'model')
  if (model) current.model = model
  proposal.draft = { ...proposal.draft, conversationId: current.id, friendIds: nextFriends, title }
}

function writeVaultBinding(document: WorkbenchDocument, proposal: Proposal): void {
  const stores = document.stores
  const draft = proposal.draft
  const bindTarget = stringField(draft, 'bindTarget') || 'provider'
  let vaultEntryId = stringField(draft, 'vaultEntryId')
  const staged = draft.stagedSecret as VaultSecretRecord | undefined
  if (staged && typeof staged === 'object' && typeof staged.id === 'string' && typeof staged.ciphertext === 'string') {
    upsertSecretRecord(stores, staged)
    vaultEntryId = staged.id
  }
  if (!vaultEntryId) throw new AppError(400, '保险库绑定缺少条目，没有写入。')
  if (!stores.secrets.some((item) => item.id === vaultEntryId)) {
    throw new AppError(400, '保险库里没有这条密钥，没有写入。')
  }

  if (bindTarget === 'provider') {
    const providerId = stringField(draft, 'providerId') || stringField(draft, 'id')
    const provider = stores.providers.find((item) => item.id === providerId)
    if (!provider) throw new AppError(400, '要绑定的提供方不存在，没有写入。')
    provider.vaultEntryId = vaultEntryId
    provider.updatedAt = Date.now()
  } else {
    const settings = normalizeAppSettings(document.settings)
    if (bindTarget === 'mail_imap') {
      settings.mailInstructions.imap = { ...settings.mailInstructions.imap, vaultEntryId }
    } else {
      settings.mailInstructions.smtp = { ...settings.mailInstructions.smtp, vaultEntryId }
    }
    document.settings = settings
  }

  proposal.draft = {
    name: proposal.name,
    bindTarget,
    vaultEntryId,
    ...(typeof draft.apiKeyMasked === 'string' ? { apiKeyMasked: draft.apiKeyMasked } : {}),
    ...(typeof draft.passwordMasked === 'string' ? { passwordMasked: draft.passwordMasked } : {}),
    ...(stringField(draft, 'providerId') ? { providerId: stringField(draft, 'providerId') } : {}),
  }
}

function upsertSecretRecord(
  stores: { secrets: VaultSecretRecord[] },
  record: VaultSecretRecord,
): void {
  const index = stores.secrets.findIndex((item) => item.id === record.id)
  if (index === -1) stores.secrets.push(record)
  else stores.secrets[index] = record
}

function writeTask(
  stores: { tasks: AutomationTask[]; friends: { id: string }[] },
  proposal: Proposal,
  scope: SettingScope,
  friendIds: string[] | undefined,
): void {
  const friendId = stringField(proposal.draft, 'friendId') || friendIds?.[0] || ''
  if (!friendId || !stores.friends.some((item) => item.id === friendId)) {
    throw new AppError(400, '绑定的好友不存在，没有写入任务。')
  }
  const schedule = proposal.draft.schedule === 'cron' ? 'cron' : 'manual'
  const cron = stringField(proposal.draft, 'cron')
  if (schedule === 'cron' && !cron) throw new AppError(400, '定时任务缺少 Cron，没有写入。')
  const now = Date.now()
  stores.tasks.push({
    id: crypto.randomUUID(),
    name: proposal.name,
    friendId,
    prompt: stringField(proposal.draft, 'body'),
    schedule,
    scope,
    enabled: true,
    lastStatus: 'none',
    history: [],
    createdAt: now,
    updatedAt: now,
    ...(cron ? { cron } : {}),
    ...(friendIds ? { friendIds } : {}),
    ...(stringField(proposal.draft, 'targetConversationId')
      ? { targetConversationId: stringField(proposal.draft, 'targetConversationId') }
      : {}),
  })
}

function writeSkill(
  stores: { skills: Skill[] },
  proposal: Proposal,
  scope: SettingScope,
  friendIds: string[] | undefined,
): void {
  const now = Date.now()
  stores.skills.push({
    id: crypto.randomUUID(),
    name: proposal.name,
    description: proposal.summary,
    body: stringField(proposal.draft, 'body'),
    status: 'ready',
    scope,
    createdAt: now,
    updatedAt: now,
    ...(friendIds ? { friendIds } : {}),
  })
}

function writeMcp(
  stores: { mcpServers: McpServer[] },
  proposal: Proposal,
  scope: SettingScope | 'groups',
  friendIds: string[] | undefined,
  groupIds?: string[],
): void {
  const transport = proposal.draft.transport === 'sse' || proposal.draft.transport === 'http' ? proposal.draft.transport : 'stdio'
  const command = stringField(proposal.draft, 'command')
  const url = stringField(proposal.draft, 'url')
  if (transport === 'stdio' && !command) throw new AppError(400, 'stdio 服务缺少命令，没有写入。')
  if (transport !== 'stdio' && !url) throw new AppError(400, '远程服务缺少 URL，没有写入。')
  const now = Date.now()
  stores.mcpServers.push({
    id: crypto.randomUUID(),
    name: proposal.name,
    enabled: true,
    transport,
    env: [],
    headers: [],
    scope,
    createdAt: now,
    updatedAt: now,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(scope === 'friends' && friendIds ? { friendIds } : {}),
    ...(scope === 'groups' && groupIds?.length ? { groupIds } : {}),
  })
}

function writeFriend(
  stores: { friends: Friend[]; providers: { id: string; enabled: boolean }[] },
  proposal: Proposal,
): void {
  const name = (stringField(proposal.draft, 'name') || proposal.name).trim()
  if (!name) throw new AppError(400, '好友名称不能为空，没有写入。')
  if (stores.friends.some((item) => item.name === name)) {
    throw new AppError(400, `已有同名好友「${name}」，没有写入。`)
  }
  const providerId =
    stringField(proposal.draft, 'providerId') ||
    stores.providers.find((item) => item.enabled)?.id ||
    stores.providers[0]?.id ||
    ''
  if (!providerId || !stores.providers.some((item) => item.id === providerId)) {
    throw new AppError(400, '没有可用的提供方，没有写入好友。')
  }
  const defaultModelId =
    stringField(proposal.draft, 'defaultModelId') || stringField(proposal.draft, 'model')
  const now = Date.now()
  stores.friends.push({
    id: crypto.randomUUID(),
    name,
    description: stringField(proposal.draft, 'description') || proposal.summary || '',
    systemPrompt: stringField(proposal.draft, 'systemPrompt') || stringField(proposal.draft, 'body') || '',
    isOwnerTemplate: false,
    avatar: { ...DEFAULT_FRIEND_AVATAR },
    providerId,
    createdAt: now,
    updatedAt: now,
    ...(defaultModelId ? { defaultModelId } : {}),
  })
}

function stringField(draft: Record<string, unknown>, key: string): string {
  const value = draft[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stringArrayField(draft: Record<string, unknown>, key: string): string[] {
  const value = draft[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

export function summarizeConfigForModel(document: WorkbenchDocument, section: string = 'all'): string {
  const settings = normalizeAppSettings(document.settings)
  const want = (name: string) => section === 'all' || section === name
  const lines: string[] = []

  if (want('providers')) {
    lines.push('## 提供方')
    for (const provider of document.stores.providers) {
      lines.push(
        `- ${provider.name} (${provider.id}) enabled=${provider.enabled} baseUrl=${provider.baseUrl}` +
          ` defaultModel=${provider.defaultModel ?? '—'} hasApiKey=${Boolean(provider.vaultEntryId)}`,
      )
    }
  }
  if (want('app_settings')) {
    lines.push('## 应用设置')
    lines.push(`- sendWaitSeconds=${settings.sendWaitSeconds}`)
    lines.push(`- planModePrompt 长度=${settings.planModePrompt.length}`)
    lines.push(`- skillExtractPrompt 长度=${settings.skillExtractPrompt.length}`)
    lines.push(
      `- mailInstructions enabled=${settings.mailInstructions.enabled}` +
        ` whitelist=${settings.mailInstructions.whitelist.length}` +
        ` poll=${settings.mailInstructions.pollIntervalMinutes}m` +
        ` imap.hasKey=${Boolean(settings.mailInstructions.imap.vaultEntryId)}` +
        ` smtp.hasKey=${Boolean(settings.mailInstructions.smtp.vaultEntryId)}`,
    )
  }
  if (want('friends')) {
    lines.push('## 好友')
    for (const friend of document.stores.friends) {
      lines.push(
        `- ${friend.name} (${friend.id}) provider=${friend.providerId}` +
          ` model=${friend.defaultModelId ?? '—'}` +
          ` workspace=${friend.workspacePath ? '已设' : '未设'}` +
          ` systemPrompt长度=${friend.systemPrompt.length}`,
      )
    }
  }
  if (want('groups')) {
    lines.push('## 群')
    const groups = document.stores.conversations.filter((item) => item.kind === 'group')
    if (groups.length === 0) lines.push('- （无）')
    for (const group of groups) {
      lines.push(`- ${group.title} (${group.id}) members=${group.friendIds.length}`)
    }
  }
  lines.push('说明：密钥明文不会出现在本摘要；改配置请 workbench_propose，等用户确认。')
  lines.push('后置：session_prefs（会话模式/推理/模型）本包不做。')
  return lines.join('\n')
}

export type ProposalService = ReturnType<typeof createProposalService>
