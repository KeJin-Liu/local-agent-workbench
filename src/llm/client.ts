/**
 * OpenAI 兼容客户端。listModels 给设置页用；chat / chatStream 留给下一步发送，现在就把边界定下来。
 */

import { log } from '../logger.ts'
import { cursorCloudChat, cursorCloudChatStream, isCursorCloudBaseUrl } from './cursor-cloud.ts'
import { CONNECTION_HINT, LlmError, httpError } from './errors.ts'

export type ModelInfo = {
  id: string
  ownedBy?: string
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ToolCall = {
  id: string
  name: string
  arguments: string
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 文本或 OpenAI 多模态内容；视觉插件把图片作为 image_url 内联。 */
export type ChatContent = string | ChatContentPart[]

export type ChatMessage = {
  role: ChatRole
  content: ChatContent
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export type OpenAiToolSpec = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export type ChatRequest = {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  tools?: OpenAiToolSpec[]
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type ChatResponse = {
  content: string
  /** 部分模型（如 deepseek-reasoner）的思维链；无则不写。 */
  reasoning?: string
  toolCalls: ToolCall[]
  model: string
  finishReason?: string
}

export type ChatDelta = {
  content?: string
  reasoning?: string
}

export type ListModelsRequest = {
  baseUrl: string
  apiKey?: string
  signal?: AbortSignal
  timeoutMs?: number
}

type FetchLike = typeof fetch

const DEFAULT_LIST_TIMEOUT_MS = 12_000
const DEFAULT_CHAT_TIMEOUT_MS = 120_000

/** 把 baseUrl 和 /models 或 /chat/completions 拼成一个地址，去掉多余的斜杠。 */
export function joinOpenAiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** 请求 `{baseUrl}/models`，接受 data 或 models 数组。 */
export async function listModels(request: ListModelsRequest, fetchImpl: FetchLike = fetch): Promise<ModelInfo[]> {
  const url = joinOpenAiUrl(request.baseUrl, '/models')
  log('info', 'llm', '列出模型', { baseUrl: request.baseUrl })
  const response = await requestJson(
    url,
    { method: 'GET', headers: authHeaders(request.apiKey), signal: request.signal },
    request.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
    fetchImpl,
  )
  const models = parseModelList(await readJson(response))
  log('info', 'llm', '模型列表返回', { baseUrl: request.baseUrl, count: models.length })
  return models
}

/** 非流式补全。发送回合会调用它或 chatStream。Cursor 官方地址改走云端智能体。 */
export async function chat(request: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResponse> {
  if (isCursorCloudBaseUrl(request.baseUrl)) return cursorCloudChat(request, fetchImpl)
  const response = await postChat(request, false, fetchImpl)
  const body = await readJson(response)
  if (!body || typeof body !== 'object') throw new LlmError('补全响应无法解析。', 'parse')
  const record = body as {
    model?: unknown
    choices?: Array<{
      finish_reason?: unknown
      message?: { content?: unknown; tool_calls?: unknown }
    }>
  }
  const message = record.choices?.[0]?.message as
    | { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown; reasoning?: unknown }
    | undefined
  const content = typeof message?.content === 'string' ? message.content : ''
  const reasoning = pickReasoning(message)
  const toolCalls = parseToolCalls(message?.tool_calls)
  if (!content && toolCalls.length === 0 && !reasoning) throw new LlmError('补全响应里没有消息内容。', 'parse')
  const finishReason = record.choices?.[0]?.finish_reason
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    model: typeof record.model === 'string' ? record.model : request.model,
    ...(typeof finishReason === 'string' ? { finishReason } : {}),
  }
}

/** 解析 SSE，直到 data: [DONE]。Cursor 官方地址改走云端智能体的事件流。 */
export async function* chatStream(request: ChatRequest, fetchImpl: FetchLike = fetch): AsyncGenerator<ChatDelta> {
  if (isCursorCloudBaseUrl(request.baseUrl)) {
    yield* cursorCloudChatStream(request, fetchImpl)
    return
  }
  const response = await postChat(request, true, fetchImpl)
  if (!response.body) throw new LlmError('服务没有返回流式响应。', 'parse')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseSseLine(line)
      if (parsed === 'done') return
      if (parsed) yield parsed
    }
  }
  if (buffer.trim()) {
    const parsed = parseSseLine(buffer)
    if (parsed && parsed !== 'done') yield parsed
  }
}

async function postChat(request: ChatRequest, stream: boolean, fetchImpl: FetchLike): Promise<Response> {
  log('info', 'llm', stream ? '流式补全' : '补全', {
    baseUrl: request.baseUrl,
    model: request.model,
    messages: request.messages.length,
  })
  return requestJson(
    joinOpenAiUrl(request.baseUrl, '/chat/completions'),
    {
      method: 'POST',
      headers: { ...authHeaders(request.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAiMessage),
        stream,
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
      signal: request.signal,
    },
    request.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    fetchImpl,
  )
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof record.id !== 'string' || typeof record.function?.name !== 'string') continue
    calls.push({
      id: record.id,
      name: record.function.name,
      arguments: typeof record.function.arguments === 'string' ? record.function.arguments : '{}',
    })
  }
  return calls
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = apiKey?.trim()
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  try {
    const response = await fetchImpl(url, { ...init, signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpError(response.status, text)
    }
    return response
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (isTimeout(error)) {
      throw new LlmError('请求超时。', 'timeout', '请确认服务已启动，且 Base URL 指向 OpenAI 兼容的 /v1 路径。')
    }
    if (isAbort(error)) throw new LlmError('请求已取消。', 'abort')
    log('warn', 'llm', '模型请求失败', { url, error: error instanceof Error ? error.message : String(error) })
    throw new LlmError('连不上这个地址。', 'network', CONNECTION_HINT)
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' && /timeout/i.test(error.message))
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new LlmError('响应不是 JSON。', 'parse')
  }
}

function parseModelList(body: unknown): ModelInfo[] {
  if (!body || typeof body !== 'object') throw new LlmError('模型列表的响应无法解析。', 'parse')
  const record = body as { data?: unknown; models?: unknown; items?: unknown }
  // OpenAI 用 data；部分本地服务用 models；Cursor GET /v1/models 用 items。
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(record.items)
        ? record.items
        : null
  if (!raw) throw new LlmError('响应里没有 data、models 或 items 数组。', 'parse')
  const models: ModelInfo[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as { id?: unknown; owned_by?: unknown }
    if (typeof row.id !== 'string' || row.id.length === 0) continue
    models.push({
      id: row.id,
      ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}),
    })
  }
  return models
}

function parseSseLine(line: string): ChatDelta | 'done' | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data) return null
  if (data === '[DONE]') return 'done'
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    throw new LlmError('流式响应里有一段无法解析的数据。', 'parse')
  }
  if (!json || typeof json !== 'object') return null
  const delta = (json as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta
  if (!delta || typeof delta !== 'object') return null
  const content = typeof delta.content === 'string' && delta.content.length > 0 ? delta.content : undefined
  const reasoning = pickReasoning(delta)
  if (!content && !reasoning) return null
  return {
    ...(content ? { content } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

/** 归一化 reasoning_content / reasoning（DeepSeek 等兼容网关）。 */
function pickReasoning(source: { reasoning_content?: unknown; reasoning?: unknown } | null | undefined): string | undefined {
  if (!source) return undefined
  if (typeof source.reasoning_content === 'string' && source.reasoning_content.length > 0) {
    return source.reasoning_content
  }
  if (typeof source.reasoning === 'string' && source.reasoning.length > 0) {
    return source.reasoning
  }
  return undefined
}
