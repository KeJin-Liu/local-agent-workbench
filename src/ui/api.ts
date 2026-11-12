/**
 * 页面对本地接口的薄封装。失败时抛出带 hint 的 Error，方便设置页原样展示。
 */

import type { Assignment, Conversation, ConversationCard, Friend, FriendAvatar, LongTermMemory, MemoryInject, Message, MessageAttachment, PublicProvider, Run, SkillExtractDraft, SkillSuggestion, Summary } from '../domain/types.ts'
import type { ModelInfo } from '../llm/client.ts'

export type AppSettingsPayload = {
  sendWaitSeconds: number
  planModePrompt?: string
  mailInstructions?: import('../domain/types.ts').MailInstructionSettings
}

export type WorkbenchPayload = {
  ok: true
  db: { name: string; version: number }
  providers: PublicProvider[]
  friends: Friend[]
  conversations: ConversationCard[]
  settings?: AppSettingsPayload
}

export type DefaultAvatar = FriendAvatar & { kind: 'default'; id: string; path: string; label: string }

export type ThreadLongTermMemories = {
  friend: LongTermMemory[]
  project: LongTermMemory[]
  injectable: LongTermMemory[]
  friendInjectEnabled: boolean
  projectInjectEnabled: boolean
  friendOwnerId: string | null
  projectOwnerId: string | null
  friendCount: number
  projectCount: number
}

export type ThreadPayload = {
  ok: true
  conversation: Conversation
  messages: Message[]
  runs: Run[]
  assignments: Assignment[]
  summary: Summary | null
  /** p0.9：下一回合将注入的来源预览 */
  memoryInject: MemoryInject | null
  longTermMemories: ThreadLongTermMemories
  skillSuggestions: SkillSuggestion[]
  skillExtractDrafts: SkillExtractDraft[]
}

export type SendPayload = {
  ok: true
  run: Run
  message: Message
  delayMs: number
}

export type CancelPayload = {
  ok: true
  run: Run
  draftText: string
}

export type ProbePayload =
  | { ok: true; models: ModelInfo[]; elapsedMs: number }
  | { ok: false; message: string; hint?: string; status?: number; elapsedMs: number }

export class ApiError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ApiError'
    this.hint = hint
  }
}

/** 请求 JSON 接口。HTTP 失败或 ok:false 都抛 ApiError。 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  return parse<T>(response)
}

/** 探测单独走。已保存的提供方走自己的接口，这样空着的输入框会用库里的密钥，而不是把密钥再发一遍。 */
export async function probeModels(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<ProbePayload> {
  const path = input.providerId ? `/api/providers/${encodeURIComponent(input.providerId)}/probe` : '/api/probe'
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: input.baseUrl, ...(input.apiKey ? { apiKey: input.apiKey } : {}) }),
  })
  const text = await response.text()
  const body = text ? (JSON.parse(text) as ProbePayload & { message?: string; hint?: string }) : null
  if (!response.ok || !body) {
    throw new ApiError(body?.message || `请求失败 ${response.status}`, body?.hint)
  }
  return body
}


/** 上传聊天附件（图或文件），返回可挂到 send 的 attachment。 */
export async function uploadMedia(file: File): Promise<MessageAttachment> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/api/media', { method: 'POST', body })
  const payload = await parse<{ ok: true; attachment: MessageAttachment }>(response)
  return payload.attachment
}

/** 上传一张头像，返回可以写进好友的 avatar。 */
export async function uploadAvatar(file: File): Promise<FriendAvatar> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/api/avatars', { method: 'POST', body })
  const payload = await parse<{ ok: true; avatar: FriendAvatar }>(response)
  return payload.avatar
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: (T & { ok?: boolean; message?: string; hint?: string }) | null = null
  if (text) {
    try {
      body = JSON.parse(text) as T & { ok?: boolean; message?: string; hint?: string }
    } catch {
      throw new ApiError(`响应无法解析（${response.status}）`)
    }
  }
  if (!response.ok || body?.ok === false) {
    throw new ApiError(body?.message || `请求失败 ${response.status}`, body?.hint)
  }
  return body as T
}
