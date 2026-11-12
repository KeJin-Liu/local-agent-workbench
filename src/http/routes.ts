/**
 * 本地 REST。页面只跟这些路径说话，不直接碰 JSON 文件。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FriendAvatar, FriendVision, McpEnvBinding, McpTransport, SecretKind } from '../domain/types.ts'
import { createConversation, deleteConversation, loadThread, setGroupArchived, startFreshThread, updateGroupConversation } from '../app/conversations.ts'
import { planDirectoryForConversation } from '../app/plan-mode.ts'
import { AppError } from '../app/errors.ts'
import { createMcpService } from '../app/mcp.ts'
import type { AssignmentService } from '../app/assignments.ts'
import { injectSummary, writeSummary } from '../memory/commit.ts'
import type { ProposalService } from '../app/proposals.ts'
import type { CodeActionService } from '../app/code-actions.ts'
import type { CodePermission } from '../domain/types.ts'
import { detachSkill, listAttachedSkills, saveSkillForFriend } from '../app/skills.ts'
import {
  createLongTermMemory,
  deleteLongTermMemory,
  getLtmInjectPref,
  listLongTermMemories,
  setLtmInjectPref,
  updateLongTermMemory,
} from '../app/long-term-memory.ts'
import {
  acceptSkillSuggestion,
  dismissSkillSuggestion,
  listPendingSkillSuggestions,
} from '../app/skill-suggestions.ts'
import type { LongTermMemoryScope, McpScope, SettingScope } from '../domain/types.ts'
import type { TaskService } from '../app/tasks.ts'
import { probeEndpoint, rememberProbedModels, resolveProviderApiKey, toPublicProvider, upsertProvider } from '../app/providers.ts'
import type { VaultService } from '../vault/service.ts'
import { upsertFriend } from '../app/friends.ts'
import { loadWorkbench } from '../app/bootstrap.ts'
import { getAppSettings, updateAppSettings, clampSendWaitSeconds } from '../app/settings.ts'
import type { PlanModeService } from '../app/plan-mode.ts'
import type { ClarifyService } from '../app/clarify.ts'
import { ensureOwnerMailPollTask } from '../app/mail-instructions.ts'
import { pickFolder, type FolderPickerFn } from '../app/folder-picker.ts'
import {
  cancelSkillExtract,
  confirmSkillExtract,
  listFriendSessionsForSkill,
  startSkillExtract,
  type SkillExtractChatFn,
} from '../app/skill-extract.ts'
import type { ChatMode, ReasoningLevel } from '../domain/types.ts'
import type { AvatarService } from '../app/avatars.ts'
import type { MediaService } from '../app/media.ts'
import { LlmError } from '../llm/errors.ts'
import { log } from '../logger.ts'
import type { AvatarFiles } from '../storage/avatar-files.ts'
import type { MediaFiles } from '../storage/media-files.ts'
import type { Repos } from '../storage/repos/index.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import type { SessionOrchestrator } from '../session/orchestrator.ts'
import { readJson, readUploadedFile } from './body.ts'

export type ApiContext = {
  repos: Repos
  database: WorkbenchDatabase
  avatars: AvatarService
  files: AvatarFiles
  media: MediaService
  turns: SessionOrchestrator
  vault: VaultService
  mcp: ReturnType<typeof createMcpService>
  tasks: TaskService
  proposals: ProposalService
  assignments: AssignmentService
  codeActions: CodeActionService
  plans: PlanModeService
  clarifies: ClarifyService
  /** 测试可注入选目录实现。 */
  folderPicker?: FolderPickerFn
  /** 测试可注入抽技能 LLM。 */
  skillExtractChat?: SkillExtractChatFn
}

/** 写入 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * 处理 /api 与 /avatars。不是这两类路径时返回 false，交给 Vite 或构建产物。
 */
export async function handleLocal(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  const local =
    pathname.startsWith('/avatars/') || pathname.startsWith('/media/') || pathname.startsWith('/api/')
  if (!local) return false

  const started = Date.now()
  try {
    if (pathname.startsWith('/avatars/')) {
      await serveAvatar(req, res, ctx.files, pathname)
    } else if (pathname.startsWith('/media/')) {
      await serveMedia(req, res, ctx.media.files, pathname)
    } else {
      await dispatch(req, res, ctx, pathname)
    }
    log('info', 'http', 'request', {
      method: req.method,
      path: pathname,
      status: res.statusCode,
      ms: Date.now() - started,
    })
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500
    const message = error instanceof AppError ? error.message : '服务器出错'
    log(status >= 500 ? 'error' : 'info', 'http', 'request', {
      method: req.method,
      path: pathname,
      status,
      ms: Date.now() - started,
      error: message,
    })
    if (!res.headersSent) sendJson(res, status, { ok: false, message })
  }
  return true
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET'

  if (method === 'GET' && pathname === '/api/workbench') {
    const snapshot = await loadWorkbench(ctx.repos)
    const settings = await getAppSettings(ctx.database)
    sendJson(res, 200, {
      ok: true,
      ...snapshot,
      providers: snapshot.providers.map(toPublicProvider),
      settings,
    })
    return
  }

  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, { ok: true, settings: await getAppSettings(ctx.database) })
    return
  }

  if (method === 'PUT' && pathname === '/api/settings') {
    const body = asRecord(await readJson(req))
    const patch: {
      sendWaitSeconds?: number
      planModePrompt?: string
      skillExtractPrompt?: string
      mailInstructions?: Record<string, unknown>
    } = {}
    if ('sendWaitSeconds' in body) patch.sendWaitSeconds = clampSendWaitSeconds(body.sendWaitSeconds)
    if ('planModePrompt' in body) {
      if (typeof body.planModePrompt !== 'string') throw new AppError(400, 'planModePrompt 必须是字符串')
      patch.planModePrompt = body.planModePrompt
    }
    if ('skillExtractPrompt' in body) {
      if (typeof body.skillExtractPrompt !== 'string') throw new AppError(400, 'skillExtractPrompt 必须是字符串')
      patch.skillExtractPrompt = body.skillExtractPrompt
    }
    if ('mailInstructions' in body) {
      if (!body.mailInstructions || typeof body.mailInstructions !== 'object') {
        throw new AppError(400, 'mailInstructions 格式不正确')
      }
      patch.mailInstructions = body.mailInstructions as Record<string, unknown>
    }
    if (
      !('sendWaitSeconds' in patch) &&
      !('planModePrompt' in patch) &&
      !('skillExtractPrompt' in patch) &&
      !('mailInstructions' in patch)
    ) {
      throw new AppError(400, '请至少提供 sendWaitSeconds、planModePrompt、skillExtractPrompt 或 mailInstructions')
    }
    const settings = await updateAppSettings(ctx.database, patch as Parameters<typeof updateAppSettings>[1])
    if (settings.mailInstructions.enabled) {
      await ensureOwnerMailPollTask(ctx.database, settings.mailInstructions)
    }
    sendJson(res, 200, { ok: true, settings })
    return
  }

  if (method === 'POST' && pathname === '/api/workspace/pick-folder') {
    const result = await pickFolder({ picker: ctx.folderPicker })
    if (result.cancelled) {
      sendJson(res, 200, { ok: true, cancelled: true, path: null })
      return
    }
    sendJson(res, 200, { ok: true, cancelled: false, path: result.path })
    return
  }

  if (method === 'GET' && pathname === '/api/avatars/defaults') {
    sendJson(res, 200, { ok: true, avatars: await ctx.avatars.listDefaultAvatars() })
    return
  }

  if (method === 'POST' && pathname === '/api/avatars') {
    const file = await readUploadedFile(req)
    const avatar = await ctx.avatars.uploadAvatar(file)
    sendJson(res, 201, { ok: true, avatar })
    return
  }

  if (method === 'POST' && pathname === '/api/media') {
    const file = await readUploadedFile(req, 12_000_000)
    const attachment = await ctx.media.upload(file)
    sendJson(res, 201, { ok: true, attachment })
    return
  }

  const providerProbe = pathname.match(/^\/api\/providers\/([^/]+)\/probe$/)
  if (method === 'POST' && providerProbe?.[1]) {
    const id = decodeURIComponent(providerProbe[1])
    const body = asRecord(await readJson(req))
    const stored = await ctx.repos.providers.get(id)
    if (!stored) throw new AppError(404, '找不到这个提供方')
    const typedKey = optionalString(body, 'apiKey')
    const result = await probeEndpoint({
      baseUrl: optionalString(body, 'baseUrl') || stored.baseUrl,
      apiKey: await resolveProviderApiKey(stored, (id) => ctx.vault.reveal(id), typedKey),
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    })
    if (result.ok) {
      await rememberProbedModels(ctx.repos, id, result.models)
    }
    sendJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/providers') {
    const body = asRecord(await readJson(req))
    const provider = await upsertProvider(ctx.repos, providerDraft(undefined, body), ctx.vault)
    sendJson(res, 201, { ok: true, provider: toPublicProvider(provider) })
    return
  }

  const providerItem = pathname.match(/^\/api\/providers\/([^/]+)$/)
  if (method === 'PUT' && providerItem?.[1]) {
    const id = decodeURIComponent(providerItem[1])
    const body = asRecord(await readJson(req))
    const provider = await upsertProvider(ctx.repos, providerDraft(id, body), ctx.vault)
    sendJson(res, 200, { ok: true, provider: toPublicProvider(provider) })
    return
  }

  if (method === 'POST' && pathname === '/api/probe') {
    const body = asRecord(await readJson(req))
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined
    try {
      const result = await probeEndpoint({
        baseUrl: stringField(body, 'baseUrl'),
        apiKey: optionalString(body, 'apiKey'),
        ...(timeoutMs ? { timeoutMs: Math.min(timeoutMs, 30_000) } : {}),
      })
      sendJson(res, 200, result)
    } catch (error) {
      if (error instanceof LlmError) {
        sendJson(res, 200, { ok: false, message: error.message, hint: error.hint, status: error.status })
        return
      }
      throw error
    }
    return
  }

  if (method === 'GET' && pathname === '/api/vault') {
    sendJson(res, 200, { ok: true, secrets: await ctx.vault.list() })
    return
  }
  if (method === 'POST' && pathname === '/api/vault') {
    const body = asRecord(await readJson(req))
    const secret = await ctx.vault.upsert(secretDraft(undefined, body))
    sendJson(res, 201, { ok: true, secret })
    return
  }
  const vaultReveal = pathname.match(/^\/api\/vault\/([^/]+)\/reveal$/)
  if (method === 'POST' && vaultReveal?.[1]) {
    const id = decodeURIComponent(vaultReveal[1])
    const secret = await ctx.vault.reveal(id)
    if (!secret) throw new AppError(404, '找不到这条密钥')
    log('info', 'vault', '查看明文', { id })
    sendJson(res, 200, { ok: true, secret })
    return
  }
  const vaultItem = pathname.match(/^\/api\/vault\/([^/]+)$/)
  if (vaultItem?.[1] && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(vaultItem[1])
    if (method === 'DELETE') {
      await ctx.vault.remove(id)
      sendJson(res, 200, { ok: true })
      return
    }
    const secret = await ctx.vault.upsert(secretDraft(id, asRecord(await readJson(req))))
    sendJson(res, 200, { ok: true, secret })
    return
  }

  if (method === 'GET' && pathname === '/api/mcp/catalog') {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''
    sendJson(res, 200, { ok: true, entries: await ctx.mcp.listCatalog(query) })
    return
  }

  const mcpEnable = pathname.match(/^\/api\/mcp\/catalog\/([^/]+)\/enable$/)
  if (method === 'POST' && mcpEnable?.[1]) {
    const body = asRecord(await readJson(req))
    const scope = body.scope
    if (scope !== 'global' && scope !== 'friends' && scope !== 'groups') throw new AppError(400, '作用域不正确。')
    const friendIds = Array.isArray(body.friendIds)
      ? body.friendIds.filter((item): item is string => typeof item === 'string')
      : []
    const groupIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item): item is string => typeof item === 'string')
      : []
    const server = await ctx.mcp.enableFromCatalog(
      decodeURIComponent(mcpEnable[1]),
      scope,
      scope === 'groups' ? groupIds : friendIds,
    )
    sendJson(res, 200, { ok: true, server })
    return
  }

  if (method === 'GET' && pathname === '/api/mcp') {
    sendJson(res, 200, { ok: true, servers: await ctx.mcp.list() })
    return
  }
  if (method === 'POST' && pathname === '/api/mcp') {
    const server = await ctx.mcp.upsert(mcpDraft(undefined, asRecord(await readJson(req))))
    sendJson(res, 201, { ok: true, server })
    return
  }
  const mcpConnect = pathname.match(/^\/api\/mcp\/([^/]+)\/connect$/)
  if (method === 'POST' && mcpConnect?.[1]) {
    const server = await ctx.mcp.connect(decodeURIComponent(mcpConnect[1]))
    sendJson(res, 200, { ok: true, server })
    return
  }
  const mcpDisconnect = pathname.match(/^\/api\/mcp\/([^/]+)\/disconnect$/)
  if (method === 'POST' && mcpDisconnect?.[1]) {
    const server = await ctx.mcp.disconnect(decodeURIComponent(mcpDisconnect[1]))
    sendJson(res, 200, { ok: true, server })
    return
  }
  const mcpPreview = pathname.match(/^\/api\/mcp\/([^/]+)\/tools$/)
  if (method === 'POST' && mcpPreview?.[1]) {
    const tools = await ctx.mcp.preview(decodeURIComponent(mcpPreview[1]))
    sendJson(res, 200, { ok: true, tools })
    return
  }
  const mcpResources = pathname.match(/^\/api\/mcp\/([^/]+)\/resources$/)
  if (method === 'GET' && mcpResources?.[1]) {
    sendJson(res, 200, { ok: true, resources: await ctx.mcp.listResources(decodeURIComponent(mcpResources[1])) })
    return
  }

  const mcpPrompts = pathname.match(/^\/api\/mcp\/([^/]+)\/prompts$/)
  if (method === 'GET' && mcpPrompts?.[1]) {
    sendJson(res, 200, { ok: true, prompts: await ctx.mcp.listPrompts(decodeURIComponent(mcpPrompts[1])) })
    return
  }

  const mcpItem = pathname.match(/^\/api\/mcp\/([^/]+)$/)
  if (mcpItem?.[1] && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(mcpItem[1])
    if (method === 'DELETE') {
      await ctx.mcp.remove(id)
      sendJson(res, 200, { ok: true })
      return
    }
    const server = await ctx.mcp.upsert(mcpDraft(id, asRecord(await readJson(req))))
    sendJson(res, 200, { ok: true, server })
    return
  }

  const threadMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/thread$/)
  if (method === 'GET' && threadMatch?.[1]) {
    const id = decodeURIComponent(threadMatch[1])
    sendJson(res, 200, { ok: true, ...(await loadThread(ctx.repos, id)) })
    return
  }

  const summaryGenerate = pathname.match(/^\/api\/conversations\/([^/]+)\/summary$/)
  if (summaryGenerate?.[1] && (method === 'GET' || method === 'POST')) {
    const id = decodeURIComponent(summaryGenerate[1])
    if (method === 'GET') {
      const summary = (await ctx.repos.summaries.latest(id)) ?? null
      sendJson(res, 200, { ok: true, summary })
      return
    }
    const summary = await writeSummary(ctx.repos, id, 'manual', false)
    sendJson(res, 200, { ok: true, summary })
    return
  }
  const summaryInject = pathname.match(/^\/api\/conversations\/([^/]+)\/summary\/inject$/)
  if (method === 'POST' && summaryInject?.[1]) {
    const summary = await injectSummary(ctx.repos, decodeURIComponent(summaryInject[1]))
    sendJson(res, 200, { ok: true, summary })
    return
  }

  const assignmentCreate = pathname.match(/^\/api\/conversations\/([^/]+)\/assignments$/)
  if (method === 'POST' && assignmentCreate?.[1]) {
    const body = asRecord(await readJson(req))
    const assignment = await ctx.assignments.create(
      decodeURIComponent(assignmentCreate[1]),
      stringField(body, 'toFriendId'),
      stringField(body, 'instruction'),
    )
    sendJson(res, 201, { ok: true, assignment })
    return
  }
  const assignmentRetry = pathname.match(/^\/api\/assignments\/([^/]+)\/retry$/)
  if (method === 'POST' && assignmentRetry?.[1]) {
    const assignment = await ctx.assignments.retry(decodeURIComponent(assignmentRetry[1]))
    sendJson(res, 200, { ok: true, assignment })
    return
  }
  const assignmentCancel = pathname.match(/^\/api\/assignments\/([^/]+)\/cancel$/)
  if (method === 'POST' && assignmentCancel?.[1]) {
    const assignment = await ctx.assignments.cancel(decodeURIComponent(assignmentCancel[1]))
    sendJson(res, 200, { ok: true, assignment })
    return
  }

  if (method === 'GET' && pathname === '/api/skills') {
    const friendId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('friendId') ?? ''
    if (!friendId) throw new AppError(400, '要带上 friendId。')
    const skills = await listAttachedSkills(ctx.repos, friendId)
    sendJson(res, 200, { ok: true, skills })
    return
  }
  if (method === 'POST' && pathname === '/api/skills') {
    const body = asRecord(await readJson(req))
    const steps = Array.isArray(body.steps) ? body.steps.filter((item): item is string => typeof item === 'string') : []
    const skill = await saveSkillForFriend(ctx.repos, {
      name: stringField(body, 'name'),
      friendId: stringField(body, 'friendId'),
      steps,
    })
    sendJson(res, 201, { ok: true, skill })
    return
  }
  const skillItem = pathname.match(/^\/api\/skills\/([^/]+)$/)
  if (method === 'DELETE' && skillItem?.[1]) {
    const friendId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('friendId') ?? ''
    if (!friendId) throw new AppError(400, '要带上 friendId。')
    await detachSkill(ctx.repos, decodeURIComponent(skillItem[1]), friendId)
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'GET' && pathname === '/api/long-term-memories') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const scope = url.searchParams.get('scope') as LongTermMemoryScope
    const ownerId = url.searchParams.get('ownerId') ?? ''
    const memories = await listLongTermMemories(ctx.repos, scope, ownerId)
    const pref = await getLtmInjectPref(ctx.repos, scope, ownerId)
    sendJson(res, 200, { ok: true, memories, injectEnabled: pref.injectEnabled })
    return
  }
  if (method === 'POST' && pathname === '/api/long-term-memories') {
    const body = asRecord(await readJson(req))
    const scope = stringField(body, 'scope') as LongTermMemoryScope
    const memory = await createLongTermMemory(ctx.repos, {
      scope,
      ownerId: stringField(body, 'ownerId'),
      fact: stringField(body, 'fact'),
      source: body.source === 'auto' ? 'auto' : 'manual',
      injectEnabled: body.injectEnabled !== false,
      pinned: body.pinned === true,
    })
    sendJson(res, 201, { ok: true, memory })
    return
  }
  if (method === 'POST' && pathname === '/api/long-term-memories/inject-pref') {
    const body = asRecord(await readJson(req))
    const scope = stringField(body, 'scope') as LongTermMemoryScope
    const pref = await setLtmInjectPref(ctx.repos, scope, stringField(body, 'ownerId'), body.injectEnabled !== false)
    sendJson(res, 200, { ok: true, pref })
    return
  }
  const ltmItem = pathname.match(/^\/api\/long-term-memories\/([^/]+)$/)
  if (ltmItem?.[1] && (method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(ltmItem[1])
    if (method === 'DELETE') {
      await deleteLongTermMemory(ctx.repos, id)
      sendJson(res, 200, { ok: true })
      return
    }
    const body = asRecord(await readJson(req))
    const memory = await updateLongTermMemory(ctx.repos, id, {
      ...(typeof body.fact === 'string' ? { fact: body.fact } : {}),
      ...(typeof body.injectEnabled === 'boolean' ? { injectEnabled: body.injectEnabled } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    })
    sendJson(res, 200, { ok: true, memory })
    return
  }


  const skillSessions = pathname.match(/^\/api\/friends\/([^/]+)\/skill-sessions$/)
  if (method === 'GET' && skillSessions) {
    const friendId = decodeURIComponent(skillSessions[1]!)
    const url = new URL(req.url || '/', 'http://local')
    const current = url.searchParams.get('currentConversationId') || undefined
    const sessions = await listFriendSessionsForSkill(ctx.repos, friendId, current)
    sendJson(res, 200, { ok: true, sessions })
    return
  }

  if (method === 'POST' && pathname === '/api/skill-extracts') {
    const body = asRecord(await readJson(req))
    const targetConversationId = stringField(body, 'targetConversationId')
    const friendId = stringField(body, 'friendId')
    const rawIds = body.sourceConversationIds
    if (!Array.isArray(rawIds)) throw new AppError(400, '请选择至少一个会话')
    const sourceConversationIds = rawIds.map((item) => String(item).trim()).filter(Boolean)
    const settings = await getAppSettings(ctx.database)
    const result = await startSkillExtract(ctx.repos, {
      targetConversationId,
      friendId,
      sourceConversationIds,
      skillExtractPrompt: settings.skillExtractPrompt,
      chatFn: ctx.skillExtractChat,
    })
    sendJson(res, 200, { ok: true, draft: result.draft, messageId: result.messageId })
    return
  }

  const skillExtractConfirm = pathname.match(/^\/api\/skill-extracts\/([^/]+)\/confirm$/)
  if (method === 'POST' && skillExtractConfirm) {
    const body = asRecord(await readJson(req))
    const name = optionalString(body, 'name')
    const result = await confirmSkillExtract(ctx.repos, decodeURIComponent(skillExtractConfirm[1]!), {
      ...(name !== undefined ? { name } : {}),
    })
    sendJson(res, 200, { ok: true, draft: result.draft, skill: result.skill })
    return
  }

  const skillExtractCancel = pathname.match(/^\/api\/skill-extracts\/([^/]+)\/cancel$/)
  if (method === 'POST' && skillExtractCancel) {
    const draft = await cancelSkillExtract(ctx.repos, decodeURIComponent(skillExtractCancel[1]!))
    sendJson(res, 200, { ok: true, draft })
    return
  }

  const suggestionList = pathname.match(/^\/api\/conversations\/([^/]+)\/skill-suggestions$/)
  if (method === 'GET' && suggestionList?.[1]) {
    const suggestions = await listPendingSkillSuggestions(ctx.repos, decodeURIComponent(suggestionList[1]))
    sendJson(res, 200, { ok: true, suggestions })
    return
  }
  const suggestionAccept = pathname.match(/^\/api\/skill-suggestions\/([^/]+)\/accept$/)
  if (method === 'POST' && suggestionAccept?.[1]) {
    const body = asRecord(await readJson(req))
    const scope = stringField(body, 'scope') as SettingScope
    const friendIds = Array.isArray(body.friendIds)
      ? body.friendIds.filter((item): item is string => typeof item === 'string')
      : undefined
    const result = await acceptSkillSuggestion(ctx.repos, decodeURIComponent(suggestionAccept[1]), {
      name: typeof body.name === 'string' ? body.name : undefined,
      scope,
      friendIds,
      muteSimilar: body.muteSimilar === true,
    })
    sendJson(res, 200, { ok: true, ...result })
    return
  }
  const suggestionDismiss = pathname.match(/^\/api\/skill-suggestions\/([^/]+)\/dismiss$/)
  if (method === 'POST' && suggestionDismiss?.[1]) {
    const body = asRecord(await readJson(req).catch(() => ({})))
    const muteSimilar = Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).muteSimilar === true)
    await dismissSkillSuggestion(ctx.repos, decodeURIComponent(suggestionDismiss[1]), muteSimilar)
    sendJson(res, 200, { ok: true })
    return
  }


  const composerPatch = pathname.match(/^\/api\/conversations\/([^/]+)\/composer$/)
  if (method === 'PATCH' && composerPatch?.[1]) {
    const id = decodeURIComponent(composerPatch[1])
    const conversation = await ctx.repos.conversations.get(id)
    if (!conversation) throw new AppError(404, '找不到这个会话')
    const body = asRecord(await readJson(req))
    const next = { ...conversation, updatedAt: Date.now() }
    if ('model' in body) {
      const model = optionalString(body, 'model')
      if (model) next.model = model
      else delete next.model
    }
    if ('providerId' in body) {
      const providerId = optionalString(body, 'providerId')
      if (!providerId) throw new AppError(400, 'providerId 不能为空')
      const provider = await ctx.repos.providers.get(providerId)
      if (!provider) throw new AppError(400, '找不到这个提供方')
      next.providerId = providerId
    }
    if ('chatMode' in body) {
      const mode = body.chatMode
      if (mode !== 'normal' && mode !== 'plan') throw new AppError(400, 'chatMode 只能是 normal 或 plan')
      next.chatMode = mode as ChatMode
    }
    if ('reasoningLevel' in body) {
      const level = body.reasoningLevel
      if (level !== 'low' && level !== 'medium' && level !== 'high') {
        throw new AppError(400, 'reasoningLevel 只能是 low / medium / high')
      }
      next.reasoningLevel = level as ReasoningLevel
    }
    await ctx.repos.conversations.put(next)
    sendJson(res, 200, { ok: true, conversation: next })
    return
  }

  const plansList = pathname.match(/^\/api\/conversations\/([^/]+)\/plans$/)
  if (plansList?.[1] && method === 'GET') {
    const id = decodeURIComponent(plansList[1])
    const plans = await ctx.plans.listByConversation(id)
    sendJson(res, 200, { ok: true, plans })
    return
  }
  if (plansList?.[1] && method === 'POST') {
    const id = decodeURIComponent(plansList[1])
    const conversation = await ctx.repos.conversations.get(id)
    if (!conversation) throw new AppError(404, '找不到这个会话')
    const body = asRecord(await readJson(req))
    const title = stringField(body, 'title')
    const stepsRaw = body.steps
    const steps = Array.isArray(stepsRaw)
      ? stepsRaw.filter((item): item is string => typeof item === 'string')
      : []
    const acceptanceRaw = body.acceptance
    const acceptance = Array.isArray(acceptanceRaw)
      ? acceptanceRaw.filter((item): item is string => typeof item === 'string')
      : undefined
    const plan = await ctx.plans.draftPlan({
      conversationId: id,
      title,
      steps,
      rootDir: planDirectoryForConversation(conversation),
      ...(optionalString(body, 'friendId') ? { friendId: optionalString(body, 'friendId') } : {}),
      ...(optionalString(body, 'goal') ? { goal: optionalString(body, 'goal') } : {}),
      ...(acceptance ? { acceptance } : {}),
      ...(optionalString(body, 'flow') ? { flow: optionalString(body, 'flow') } : {}),
      ...(optionalString(body, 'fields') ? { fields: optionalString(body, 'fields') } : {}),
      ...(optionalString(body, 'risks') ? { risks: optionalString(body, 'risks') } : {}),
      ...(optionalString(body, 'rollback') ? { rollback: optionalString(body, 'rollback') } : {}),
    })
    sendJson(res, 201, { ok: true, plan })
    return
  }

  const planGet = pathname.match(/^\/api\/plans\/([^/]+)$/)
  if (method === 'GET' && planGet?.[1]) {
    const plan = await ctx.plans.get(decodeURIComponent(planGet[1]))
    sendJson(res, 200, { ok: true, plan })
    return
  }
  const planConfirm = pathname.match(/^\/api\/plans\/([^/]+)\/confirm$/)
  if (method === 'POST' && planConfirm?.[1]) {
    const plan = await ctx.plans.confirmStart(decodeURIComponent(planConfirm[1]))
    sendJson(res, 200, { ok: true, plan })
    return
  }
  const planCancel = pathname.match(/^\/api\/plans\/([^/]+)\/cancel$/)
  if (method === 'POST' && planCancel?.[1]) {
    const plan = await ctx.plans.cancel(decodeURIComponent(planCancel[1]))
    sendJson(res, 200, { ok: true, plan })
    return
  }
  const planStep = pathname.match(/^\/api\/plans\/([^/]+)\/steps\/(\d+)\/done$/)
  if (method === 'POST' && planStep?.[1] && planStep[2] !== undefined) {
    const body = asRecord(await readJson(req).catch(() => ({})))
    const plan = await ctx.plans.markStepDone(
      decodeURIComponent(planStep[1]),
      Number(planStep[2]),
      optionalString(body, 'result'),
    )
    sendJson(res, 200, { ok: true, plan })
    return
  }

  const clarifyList = pathname.match(/^\/api\/conversations\/([^/]+)\/clarifies$/)
  if (method === 'GET' && clarifyList?.[1]) {
    const cards = await ctx.clarifies.listByConversation(decodeURIComponent(clarifyList[1]))
    sendJson(res, 200, { ok: true, clarifies: cards })
    return
  }
  const clarifyAnswer = pathname.match(/^\/api\/clarifies\/([^/]+)\/answer$/)
  if (method === 'POST' && clarifyAnswer?.[1]) {
    const body = asRecord(await readJson(req))
    const card = await ctx.clarifies.answer(decodeURIComponent(clarifyAnswer[1]), stringField(body, 'option'))
    sendJson(res, 200, { ok: true, clarify: card })
    return
  }

  const groupMcp = pathname.match(/^\/api\/conversations\/([^/]+)\/mcp$/)
  if (method === 'PUT' && groupMcp?.[1]) {
    const body = asRecord(await readJson(req))
    const serverIds = Array.isArray(body.serverIds)
      ? body.serverIds.filter((item): item is string => typeof item === 'string')
      : null
    if (!serverIds) throw new AppError(400, 'serverIds 需要是字符串数组。')
    await ctx.mcp.setGroupBindings(decodeURIComponent(groupMcp[1]), serverIds)
    sendJson(res, 200, { ok: true })
    return
  }

  const freshMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/new-chat$/)
  if (method === 'POST' && freshMatch?.[1]) {
    const conversation = await startFreshThread(ctx.repos, decodeURIComponent(freshMatch[1]))
    sendJson(res, 201, { ok: true, conversation })
    return
  }

  const sendMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/send$/)
  if (method === 'POST' && sendMatch?.[1]) {
    const id = decodeURIComponent(sendMatch[1])
    const body = asRecord(await readJson(req))
    const delayMs = typeof body.delayMs === 'number' ? body.delayMs : undefined
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((item): item is string => typeof item === 'string')
      : undefined
    const attachments = attachmentIds?.length ? await ctx.media.resolveMany(attachmentIds) : undefined
    const result = await ctx.turns.sendTurn({
      conversationId: id,
      text: optionalString(body, 'text') ?? '',
      clientTurnId: optionalString(body, 'clientTurnId'),
      model: optionalString(body, 'model'),
      providerId: optionalString(body, 'providerId'),
      ...(attachments ? { attachments } : {}),
      ...(delayMs === undefined ? {} : { delayMs }),
    })
    sendJson(res, 201, { ok: true, ...result })
    return
  }

  const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (method === 'POST' && cancelMatch?.[1]) {
    const runId = decodeURIComponent(cancelMatch[1])
    const result = await ctx.turns.cancelRun(runId)
    sendJson(res, 200, { ok: true, ...result })
    return
  }

  if (method === 'POST' && pathname === '/api/conversations') {
    const body = asRecord(await readJson(req))
    const rawIds = Array.isArray(body.friendIds) ? body.friendIds : body.roleIds
    const friendIds = Array.isArray(rawIds) ? rawIds.filter((item): item is string => typeof item === 'string') : undefined
    const kind = body.kind === 'group' ? 'group' : body.kind === 'direct' ? 'direct' : undefined
    // 群头像走和好友头像一样的校验；null / 缺省表示用默认「群」字块。
    const avatar =
      body.avatar === null || body.avatar === undefined
        ? undefined
        : await ctx.avatars.resolveAvatar(avatarField(body.avatar))
    const conversation = await createConversation(ctx.repos, stringField(body, 'title'), {
      ...(kind ? { kind } : {}),
      ...(friendIds ? { friendIds } : {}),
      ...(optionalString(body, 'model') ? { model: optionalString(body, 'model') } : {}),
      ...(avatar ? { avatar } : {}),
      ...(typeof body.workspaceRoot === 'string' ? { workspaceRoot: body.workspaceRoot } : {}),
      ...(isStringRecord(body.memberWorkspaces) ? { memberWorkspaces: body.memberWorkspaces } : {}),
      ...(isStringRecord(body.memberPrompts) ? { memberPrompts: body.memberPrompts } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'memberModels')
        ? { memberModels: parseMemberModels(body.memberModels) ?? undefined }
        : {}),
    })
    sendJson(res, 201, { ok: true, conversation })
    return
  }

  const archiveItem = pathname.match(/^\/api\/conversations\/([^/]+)\/archive$/)
  if (method === 'POST' && archiveItem?.[1]) {
    const body = asRecord(await readJson(req))
    if (typeof body.archived !== 'boolean') throw new AppError(400, 'archived 需要是布尔值。')
    const conversation = await setGroupArchived(ctx.repos, decodeURIComponent(archiveItem[1]), body.archived)
    sendJson(res, 200, { ok: true, conversation })
    return
  }

  const conversationItem = pathname.match(/^\/api\/conversations\/([^/]+)$/)
  if (method === 'PUT' && conversationItem?.[1]) {
    const body = asRecord(await readJson(req))
    const rawIds = Array.isArray(body.friendIds) ? body.friendIds : []
    const friendIds = rawIds.filter((item): item is string => typeof item === 'string')
    const avatar =
      body.avatar === null
        ? null
        : body.avatar === undefined
          ? undefined
          : await ctx.avatars.resolveAvatar(avatarField(body.avatar))
    const conversation = await updateGroupConversation(ctx.repos, decodeURIComponent(conversationItem[1]), {
      title: stringField(body, 'title'),
      friendIds,
      ...(optionalString(body, 'model') ? { model: optionalString(body, 'model') } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'workspaceRoot')
        ? { workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'memberWorkspaces')
        ? { memberWorkspaces: isStringRecord(body.memberWorkspaces) ? body.memberWorkspaces : null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'memberPrompts')
        ? { memberPrompts: isStringRecord(body.memberPrompts) ? body.memberPrompts : null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'memberModels')
        ? { memberModels: parseMemberModels(body.memberModels) }
        : {}),
    })
    sendJson(res, 200, { ok: true, conversation })
    return
  }

  if (method === 'DELETE' && pathname.startsWith('/api/conversations/')) {
    const id = decodeURIComponent(pathname.slice('/api/conversations/'.length))
    await deleteConversation(ctx.repos, id)
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, { ok: true, tasks: await ctx.tasks.list() })
    return
  }
  if (method === 'POST' && pathname === '/api/tasks') {
    const body = asRecord(await readJson(req))
    const task = await ctx.tasks.upsert(taskDraft(undefined, body))
    sendJson(res, 201, { ok: true, task })
    return
  }
  const taskRun = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/)
  if (method === 'POST' && taskRun?.[1]) {
    const task = await ctx.tasks.run(decodeURIComponent(taskRun[1]))
    sendJson(res, 200, { ok: true, task })
    return
  }
  const taskStop = pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/)
  if (method === 'POST' && taskStop?.[1]) {
    const task = await ctx.tasks.stop(decodeURIComponent(taskStop[1]))
    sendJson(res, 200, { ok: true, task })
    return
  }
  const taskItem = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskItem?.[1] && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(taskItem[1])
    if (method === 'DELETE') {
      await ctx.tasks.remove(id)
      sendJson(res, 200, { ok: true })
      return
    }
    const task = await ctx.tasks.upsert(taskDraft(id, asRecord(await readJson(req))))
    sendJson(res, 200, { ok: true, task })
    return
  }

  const proposalList = pathname.match(/^\/api\/conversations\/([^/]+)\/proposals$/)
  if (method === 'GET' && proposalList?.[1]) {
    const proposals = await ctx.proposals.listPending(decodeURIComponent(proposalList[1]))
    sendJson(res, 200, { ok: true, proposals })
    return
  }
  const proposalConfirm = pathname.match(/^\/api\/proposals\/([^/]+)\/confirm$/)
  if (method === 'POST' && proposalConfirm?.[1]) {
    const body = asRecord(await readJson(req))
    const scope = body.scope === 'friends' ? 'friends' : body.scope === 'groups' ? 'groups' : body.scope === 'global' ? 'global' : ''
    if (!scope) throw new AppError(400, '作用域需要是 global、friends 或 groups。')
    const friendIds = Array.isArray(body.friendIds)
      ? body.friendIds.filter((item): item is string => typeof item === 'string')
      : []
    const groupIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item): item is string => typeof item === 'string')
      : []
    const fields = {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.defaultModelId === 'string'
        ? { defaultModelId: body.defaultModelId }
        : typeof body.model === 'string'
          ? { defaultModelId: body.model }
          : {}),
    }
    const proposal = await ctx.proposals.confirm(decodeURIComponent(proposalConfirm[1]), scope, friendIds, fields, groupIds)
    sendJson(res, 200, { ok: true, proposal })
    return
  }
  const proposalCancel = pathname.match(/^\/api\/proposals\/([^/]+)\/cancel$/)
  if (method === 'POST' && proposalCancel?.[1]) {
    await ctx.proposals.cancel(decodeURIComponent(proposalCancel[1]))
    sendJson(res, 200, { ok: true })
    return
  }

  const codeActionList = pathname.match(/^\/api\/conversations\/([^/]+)\/code-actions$/)
  if (method === 'GET' && codeActionList?.[1]) {
    const actions = await ctx.codeActions.listPending(decodeURIComponent(codeActionList[1]))
    sendJson(res, 200, { ok: true, actions })
    return
  }
  const codeTimeline = pathname.match(/^\/api\/conversations\/([^/]+)\/code-timeline$/)
  if (method === 'GET' && codeTimeline?.[1]) {
    const events = await ctx.codeActions.listTimeline(decodeURIComponent(codeTimeline[1]))
    sendJson(res, 200, { ok: true, events })
    return
  }
  const codeConfirm = pathname.match(/^\/api\/code-actions\/([^/]+)\/confirm$/)
  if (method === 'POST' && codeConfirm?.[1]) {
    const action = await ctx.codeActions.confirm(decodeURIComponent(codeConfirm[1]))
    sendJson(res, 200, { ok: true, action })
    return
  }
  const codeCancel = pathname.match(/^\/api\/code-actions\/([^/]+)\/cancel$/)
  if (method === 'POST' && codeCancel?.[1]) {
    await ctx.codeActions.cancel(decodeURIComponent(codeCancel[1]))
    sendJson(res, 200, { ok: true })
    return
  }

  if ((method === 'POST' || method === 'PUT') && (pathname === '/api/friends' || pathname.startsWith('/api/friends/'))) {
    const id = pathname === '/api/friends' ? undefined : decodeURIComponent(pathname.slice('/api/friends/'.length))
    const body = asRecord(await readJson(req))
    const defaultModelId =
      optionalString(body, 'defaultModelId') ?? optionalString(body, 'model')
    const workspacePath = optionalString(body, 'workspacePath')
    const codePermissionRaw = optionalString(body, 'codePermission')
    let codePermission: CodePermission | null | undefined
    if (codePermissionRaw !== undefined) {
      if (
        codePermissionRaw !== '' &&
        codePermissionRaw !== 'read-only' &&
        codePermissionRaw !== 'workspace-write' &&
        codePermissionRaw !== 'danger-full-access'
      ) {
        throw new AppError(400, '编码权限不正确。')
      }
      codePermission = codePermissionRaw === '' ? null : (codePermissionRaw as CodePermission)
    }
    const vision =
      body.vision === null
        ? null
        : body.vision === undefined
          ? undefined
          : visionField(body.vision)
    const friend = await upsertFriend(ctx.repos, ctx.avatars, {
      ...(id ? { id } : {}),
      name: stringField(body, 'name'),
      description: optionalString(body, 'description'),
      systemPrompt: optionalString(body, 'systemPrompt'),
      providerId: optionalString(body, 'providerId'),
      ...(defaultModelId !== undefined ? { defaultModelId } : {}),
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(codePermissionRaw !== undefined ? { codePermission } : {}),
      ...(vision !== undefined ? { vision } : {}),
      avatar: avatarField(body.avatar),
    })
    sendJson(res, method === 'POST' ? 201 : 200, { ok: true, friend })
    return
  }

  throw new AppError(404, '没有这个接口')
}


async function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  files: MediaFiles,
  pathname: string,
): Promise<void> {
  const filesPrefix = '/media/files/'
  if (!pathname.startsWith(filesPrefix)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const fileName = decodeURIComponent(pathname.slice(filesPrefix.length))
  const body = await files.read(fileName)
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const id = fileName.replace(/\.[^.]+$/, '')
  const meta = await files.readMeta(id)
  const type = meta?.mime || mimeFor(fileName)
  const download = new URL(req.url ?? '/', 'http://localhost').searchParams.get('download') === '1'
  const headers: Record<string, string | number> = {
    'content-type': type,
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  }
  if (download) {
    const name = (meta?.name || fileName).replace(/"/g, '')
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  }
  res.writeHead(200, headers)
  res.end(body)
}

async function serveAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  files: AvatarFiles,
  pathname: string,
): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET' && req.method !== 'HEAD') {
    throw new AppError(405, '只支持读取头像')
  }
  const defaultsPrefix = '/avatars/defaults/'
  const filesPrefix = '/avatars/files/'
  let body: Buffer | undefined
  let type = 'application/octet-stream'
  if (pathname.startsWith(defaultsPrefix)) {
    const id = decodeURIComponent(pathname.slice(defaultsPrefix.length)).replace(/\.svg$/i, '')
    body = await files.readDefault(id)
    type = 'image/svg+xml'
  } else if (pathname.startsWith(filesPrefix)) {
    const fileName = decodeURIComponent(pathname.slice(filesPrefix.length))
    body = await files.readUpload(fileName)
    type = mimeFor(fileName)
  } else {
    throw new AppError(404, '没有这个头像')
  }
  if (!body) throw new AppError(404, '没有这个头像')
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'cache-control': pathname.startsWith(defaultsPrefix) ? 'public, max-age=3600' : 'private, max-age=3600',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function mimeFor(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, '请求体需要是对象')
  }
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') throw new AppError(400, `缺少 ${key}`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new AppError(400, `${key} 需要是字符串`)
  return value
}

function parseMemberModels(value: unknown): Record<string, { providerId: string; model: string }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const next: Record<string, { providerId: string; model: string }> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    if (!providerId || !model) continue
    next[id] = { providerId, model }
  }
  return next
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function secretDraft(id: string | undefined, body: Record<string, unknown>) {
  const kind = body.kind
  if (kind !== 'api-key' && kind !== 'login') throw new AppError(400, '密钥类型不正确。')
  return {
    ...(id ? { id } : {}),
    name: stringField(body, 'name'),
    kind: kind as SecretKind,
    username: optionalString(body, 'username'),
    apiKey: optionalString(body, 'apiKey'),
    password: optionalString(body, 'password'),
  }
}

function mcpScopeField(value: unknown): McpScope | undefined {
  if (value === undefined) return undefined
  if (value === 'global' || value === 'friends' || value === 'groups') return value
  throw new AppError(400, '作用域不正确。')
}

function mcpDraft(id: string | undefined, body: Record<string, unknown>) {
  const transport = body.transport
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
    throw new AppError(400, '传输方式不正确。')
  }
  const args = Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === 'string') : undefined
  const env = Array.isArray(body.env) ? body.env.flatMap(envBinding) : []
  const headers = Array.isArray(body.headers) ? body.headers.flatMap(envBinding) : []
  const enabled = body.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new AppError(400, 'enabled 需要是布尔值')
  const scope = mcpScopeField(body.scope)
  const friendIds = Array.isArray(body.friendIds)
    ? body.friendIds.filter((item): item is string => typeof item === 'string')
    : undefined
  const groupIds = Array.isArray(body.groupIds)
    ? body.groupIds.filter((item): item is string => typeof item === 'string')
    : undefined
  const catalogId = optionalString(body, 'catalogId')
  return {
    ...(id ? { id } : {}),
    name: stringField(body, 'name'),
    transport: transport as McpTransport,
    command: optionalString(body, 'command'),
    url: optionalString(body, 'url'),
    ...(args ? { args } : {}),
    env,
    headers,
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(scope ? { scope } : {}),
    ...(friendIds ? { friendIds } : {}),
    ...(groupIds ? { groupIds } : {}),
    ...(catalogId ? { catalogId } : {}),
  }
}

function envBinding(value: unknown): McpEnvBinding[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !record.name.trim()) return []
  const vaultEntryId = typeof record.vaultEntryId === 'string' && record.vaultEntryId
    ? record.vaultEntryId
    : typeof record.secretId === 'string' && record.secretId
      ? record.secretId
      : ''
  return [{
    name: record.name.trim(),
    ...(vaultEntryId ? { vaultEntryId } : {}),
    ...(!vaultEntryId && typeof record.value === 'string' && record.value ? { value: record.value } : {}),
  }]
}

function providerDraft(id: string | undefined, body: Record<string, unknown>) {
  const enabled = body.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new AppError(400, 'enabled 需要是布尔值')
  const clearApiKey = body.clearApiKey === true
  const vaultField = body.vaultEntryId !== undefined ? body.vaultEntryId : body.apiKeySecretId
  let vaultEntryId: string | undefined
  let clearSecret = body.clearSecret === true || clearApiKey
  if (typeof vaultField === 'string') {
    const trimmed = vaultField.trim()
    if (trimmed) vaultEntryId = trimmed
    else clearSecret = true
  } else if (vaultField != null) {
    throw new AppError(400, 'vaultEntryId 需要是字符串')
  }
  const defaultModel = optionalString(body, 'defaultModel')
  const probedRaw = body.probedModels
  const probedModels = Array.isArray(probedRaw)
    ? probedRaw.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    ...(id ? { id } : {}),
    name: stringField(body, 'name'),
    baseUrl: stringField(body, 'baseUrl'),
    apiKey: optionalString(body, 'apiKey'),
    clearApiKey,
    clearSecret,
    ...(vaultEntryId ? { vaultEntryId } : {}),
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(body.clearDefaultModel === true ? { clearDefaultModel: true } : {}),
    ...(probedModels ? { probedModels } : {}),
  }
}

function taskDraft(id: string | undefined, body: Record<string, unknown>) {
  const schedule = body.schedule === 'cron' ? 'cron' : body.schedule === 'manual' ? 'manual' : undefined
  const scope = body.scope === 'friends' ? 'friends' : body.scope === 'global' ? 'global' : undefined
  const kind: 'system_mail_poll' | 'prompt' | undefined =
    body.kind === 'system_mail_poll' ? 'system_mail_poll' : body.kind === 'prompt' ? 'prompt' : undefined
  const friendIds = Array.isArray(body.friendIds)
    ? body.friendIds.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    ...(id ? { id } : {}),
    name: stringField(body, 'name'),
    friendId: stringField(body, 'friendId'),
    prompt: optionalString(body, 'prompt'),
    cron: optionalString(body, 'cron'),
    targetConversationId: optionalString(body, 'targetConversationId'),
    ...(kind ? { kind } : {}),
    ...(schedule ? { schedule: schedule as 'manual' | 'cron' } : {}),
    ...(scope ? { scope: scope as 'global' | 'friends' } : {}),
    ...(friendIds ? { friendIds } : {}),
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
  }
}

function visionField(value: unknown): FriendVision {
  if (!value || typeof value !== 'object') throw new AppError(400, '视觉插件配置不正确。')
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  return {
    enabled: record.enabled === true,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
  }
}

function avatarField(value: unknown): FriendAvatar {
  if (!value || typeof value !== 'object') throw new AppError(400, '缺少头像')
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'default' && kind !== 'upload') throw new AppError(400, '头像 kind 不正确')
  return {
    kind,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
  }
}
