/**
 * 提供方用例：保存 Base URL，并向 OpenAI 兼容接口探测模型。
 */

import type { ApiKeyPolicy, Provider, PublicProvider } from '../domain/types.ts'
import { LlmError } from '../llm/errors.ts'
import { listModels } from '../llm/client.ts'
import type { ModelInfo } from '../llm/client.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import type { VaultService } from '../vault/service.ts'
import { AppError } from './errors.ts'

export type ProviderDraft = {
  id?: string
  name: string
  baseUrl: string
  /** 粘贴的新密钥。保存时写入保险库，不会留在提供方记录上。 */
  apiKey?: string
  /** 为 true 时取消保险库引用。空字符串本身表示「不修改」。 */
  clearApiKey?: boolean
  enabled?: boolean
  apiKeyPolicy?: ApiKeyPolicy
  /** 已有保险库条目。和粘贴的 apiKey 同时出现时，新密钥写入这一条。 */
  vaultEntryId?: string
  clearSecret?: boolean
  defaultModel?: string
  clearDefaultModel?: boolean
  probedModels?: string[]
}

export type ProbeResult =
  | { ok: true; models: ModelInfo[]; elapsedMs: number }
  | { ok: false; message: string; hint?: string; status?: number; elapsedMs: number }

/** 去掉末尾斜杠，并拒绝 http(s) 以外的协议。 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new AppError(400, 'Base URL 不能为空。')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AppError(400, 'Base URL 需要是完整的 http(s) 地址。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'Base URL 只支持 http 或 https。')
  }
  return trimmed
}

/** @param repos 本地仓库 */
export async function listProviders(repos: Repos): Promise<Provider[]> {
  const providers = await repos.providers.list()
  return providers.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 页面和接口只用这个形状。明文密钥不在这份对象里。 */
export function toPublicProvider(provider: Provider): PublicProvider {
  const legacy = provider as Provider & { apiKey?: string; apiKeySecretId?: string }
  const vaultEntryId = provider.vaultEntryId || legacy.apiKeySecretId
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKeyPolicy: provider.apiKeyPolicy,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(provider.probedModels?.length ? { probedModels: [...provider.probedModels] } : {}),
    ...(vaultEntryId ? { vaultEntryId } : {}),
    hasApiKey: Boolean(vaultEntryId),
  }
}

/**
 * 新建或更新。粘贴的 apiKey 会立刻写入保险库，提供方只留 vaultEntryId。
 * 省略 apiKey 表示不改已有引用；clearSecret / clearApiKey 才取消关联。
 * 需要密钥的提供方，没有引用时不能启用。
 */
export async function upsertProvider(repos: Repos, draft: ProviderDraft, vault?: VaultService): Promise<Provider> {
  const name = draft.name.trim()
  if (!name) throw new AppError(400, '名称不能为空。')
  const baseUrl = normalizeBaseUrl(draft.baseUrl)
  const now = Date.now()
  const existing = draft.id ? await repos.providers.get(draft.id) : undefined
  const policy = existing?.apiKeyPolicy ?? draft.apiKeyPolicy ?? 'optional'
  const typedKey = draft.apiKey?.trim()
  const vaultEntryId = await resolveVaultEntry(vault, name, typedKey, draft, existing?.vaultEntryId)
  const enabled = draft.enabled ?? existing?.enabled ?? policy !== 'required'
  if (enabled && policy === 'required' && !vaultEntryId) {
    throw new AppError(400, '这个提供方需要 API Key。粘贴一把，或选择一条保险库记录，然后再启用。')
  }
  const defaultModel = draft.clearDefaultModel
    ? undefined
    : draft.defaultModel !== undefined
      ? draft.defaultModel.trim() || undefined
      : existing?.defaultModel
  const probedModels = draft.probedModels !== undefined
    ? uniqueModelIds(draft.probedModels)
    : existing?.probedModels
  const provider: Provider = {
    id: existing?.id ?? draft.id ?? crypto.randomUUID(),
    name,
    kind: 'openai-compatible',
    apiKeyPolicy: policy,
    enabled,
    baseUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(vaultEntryId ? { vaultEntryId } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(probedModels?.length ? { probedModels } : {}),
  }
  await repos.providers.put(provider)
  log('info', 'app', '保存提供方', {
    id: provider.id,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    hasApiKey: Boolean(vaultEntryId),
    vaultEntryId,
  })
  return provider
}

/**
 * 粘贴的密钥写入保险库。已选条目就更新那一条，否则新建。
 * 没有新密钥时，clear 会取消引用，否则保留原来的 vaultEntryId。
 */
async function resolveVaultEntry(
  vault: VaultService | undefined,
  providerName: string,
  typedKey: string | undefined,
  draft: ProviderDraft,
  existingId: string | undefined,
): Promise<string | undefined> {
  if (typedKey) {
    if (!vault) throw new AppError(400, '保存密钥需要保险库。')
    const target = draft.clearSecret || draft.clearApiKey ? undefined : draft.vaultEntryId || existingId
    return storeProviderKey(vault, target, providerName, typedKey)
  }
  if (draft.clearSecret || draft.clearApiKey) return undefined
  if (draft.vaultEntryId !== undefined) return draft.vaultEntryId || undefined
  return existingId
}

async function storeProviderKey(
  vault: VaultService,
  targetId: string | undefined,
  providerName: string,
  apiKey: string,
): Promise<string> {
  if (targetId) {
    const known = (await vault.list()).find((item) => item.id === targetId)
    if (!known) throw new AppError(400, '保险库里没有这条密钥。')
    await vault.upsert({
      id: targetId,
      name: known.name,
      kind: known.kind,
      ...(known.username ? { username: known.username } : {}),
      apiKey,
    })
    return targetId
  }
  const created = await vault.upsert({
    name: `${providerName} 的密钥`,
    kind: 'api-key',
    apiKey,
  })
  return created.id
}

/** 发送前确认提供方开着，且已经关联保险库（需要密钥时）。 */
export function assertProviderReady(provider: Provider): void {
  if (!provider.enabled) throw new AppError(400, `${provider.name} 已停用。到模型设置里启用后再发送。`)
  if (provider.apiKeyPolicy === 'required' && !provider.vaultEntryId) {
    throw new AppError(400, `${provider.name} 需要 API Key。`)
  }
}

/**
 * 解析真正拿去请求的密钥。调用方传入的新密钥只用于这一次探测，不会落盘。
 * 已保存的密钥只从保险库引用里取。不要把返回值写进日志。
 */
export async function resolveProviderApiKey(
  provider: Provider,
  reveal: (vaultEntryId: string) => Promise<{ apiKey?: string; password?: string } | undefined>,
  override?: string,
): Promise<string | undefined> {
  const typed = override?.trim()
  if (typed) return typed
  if (!provider.vaultEntryId) return undefined
  const secret = await reveal(provider.vaultEntryId)
  if (!secret) throw new AppError(400, '保险库里没有这条密钥。')
  return secret.apiKey || secret.password
}

/** 按当前表单里的地址探测，不必先保存。密钥只发给这个 baseUrl。 */
export async function probeEndpoint(input: {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}): Promise<ProbeResult> {
  const started = Date.now()
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  try {
    const models = await listModels({
      baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
    })
    return { ok: true, models, elapsedMs: Date.now() - started }
  } catch (error) {
    const llm = error instanceof LlmError ? error : new LlmError('探测失败。', 'network')
    log('warn', 'llm', '探测失败', { baseUrl, code: llm.code, status: llm.status })
    return {
      ok: false,
      message: llm.message,
      elapsedMs: Date.now() - started,
      ...(llm.hint ? { hint: llm.hint } : {}),
      ...(llm.status ? { status: llm.status } : {}),
    }
  }
}

/** 探测成功后把模型 id 记到提供方，供聊天菜单点选。 */
export async function rememberProbedModels(
  repos: Repos,
  providerId: string,
  models: ModelInfo[],
): Promise<Provider | undefined> {
  const existing = await repos.providers.get(providerId)
  if (!existing) return undefined
  const probedModels = uniqueModelIds(models.map((item) => item.id))
  const next: Provider = {
    id: existing.id,
    name: existing.name,
    kind: existing.kind,
    baseUrl: existing.baseUrl,
    apiKeyPolicy: existing.apiKeyPolicy,
    enabled: existing.enabled,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
    ...(existing.vaultEntryId ? { vaultEntryId: existing.vaultEntryId } : {}),
    ...(existing.defaultModel ? { defaultModel: existing.defaultModel } : {}),
    ...(probedModels.length ? { probedModels } : {}),
  }
  await repos.providers.put(next)
  return next
}

function uniqueModelIds(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
