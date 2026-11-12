/**
 * Cursor 官方根地址只有模型目录和 Cloud Agents，没有 OpenAI 的 /chat/completions。
 * 对话改成创建一次无仓库的云端智能体，读完回复后删掉，避免在账号里堆代理。
 */

import type { ChatContent, ChatDelta, ChatMessage, ChatRequest, ChatResponse } from './client.ts'
import { LlmError, httpError } from './errors.ts'
import { log } from '../logger.ts'

const CREATE_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS = 300_000

type CursorImage = { data: string; mimeType: string } | { url: string }

type CreatedRun = { agentId: string; runId: string }

export function isCursorCloudBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname === 'api.cursor.com'
  } catch {
    return false
  }
}

/** 非流式：收齐云端智能体的最终正文。没有 OpenAI 式 tool_calls。 */
export async function cursorCloudChat(request: ChatRequest, fetchImpl: typeof fetch = fetch): Promise<ChatResponse> {
  let content = ''
  let reasoning = ''
  for await (const delta of cursorCloudChatStream(request, fetchImpl)) {
    if (delta.content) content += delta.content
    if (delta.reasoning) reasoning += delta.reasoning
  }
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls: [],
    model: request.model,
  }
}

/** 流式：assistant / thinking 事件是增量；result.text 是全文，只补还没出现的后缀。 */
export async function* cursorCloudChatStream(
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<ChatDelta> {
  const apiKey = request.apiKey?.trim()
  if (!apiKey) {
    throw new LlmError('Cursor 需要 API Key。', 'http', '请在设置里为 Cursor 填好密钥后再发送。', 401)
  }
  const prompt = renderPrompt(request.messages)
  if (!prompt.text.trim()) throw new LlmError('没有可发送的内容。', 'parse')

  log('info', 'llm', 'Cursor 云端对话', { model: request.model, messages: request.messages.length })
  const created = await createRun(request, apiKey, prompt, fetchImpl)
  let content = ''
  let reasoning = ''
  let failed: unknown
  try {
    const response = await cursorFetch(
      agentUrl(request.baseUrl, `/${encodeURIComponent(created.agentId)}/runs/${encodeURIComponent(created.runId)}/stream`),
      { method: 'GET', headers: { ...authHeaders(apiKey), accept: 'text/event-stream' } },
      STREAM_TIMEOUT_MS,
      fetchImpl,
      request.signal,
    )
    if (!response.body) throw new LlmError('Cursor 没有返回流式响应。', 'parse')
    for await (const event of readSse(response.body)) {
      throwIfAborted(request.signal)
      if (event.event === 'assistant') {
        const text = readString(event.json, 'text')
        if (!text) continue
        content += text
        yield { content: text }
      } else if (event.event === 'thinking') {
        const text = readString(event.json, 'text')
        if (!text) continue
        reasoning += text
        yield { reasoning: text }
      } else if (event.event === 'result') {
        const status = readString(event.json, 'status')
        if (status === 'CANCELLED') throw new LlmError('请求已取消。', 'abort')
        if (status === 'ERROR' || status === 'EXPIRED') {
          throw new LlmError(readString(event.json, 'text') || 'Cursor 云端对话失败。', 'http', undefined, 502)
        }
        const extra = unseenSuffix(readString(event.json, 'text'), content)
        if (extra) {
          content += extra
          yield { content: extra }
        }
      } else if (event.event === 'error') {
        throw new LlmError(readString(event.json, 'message') || 'Cursor 云端对话失败。', 'http', undefined, 502)
      } else if (event.event === 'done') {
        break
      }
    }
  } catch (error) {
    failed = error
    throw error
  } finally {
    await disposeRun(request.baseUrl, apiKey, created, fetchImpl, Boolean(request.signal?.aborted) || failed instanceof LlmError && failed.code === 'abort')
  }
  if (!content && !reasoning) throw new LlmError('Cursor 没有返回正文。', 'parse')
  log('info', 'llm', 'Cursor 云端对话已结束', { model: request.model })
}

function renderPrompt(messages: ChatMessage[]): { text: string; images: CursorImage[] } {
  const images: CursorImage[] = []
  const lines = [
    '你在本地工作台里直接回复用户。只输出给用户看的正文。不要修改文件，不要创建 PR，不要执行命令。',
    '',
  ]
  for (const message of messages) {
    const flat = flattenContent(message.content, images)
    if (!flat) continue
    lines.push(`${message.role}: ${flat}`)
  }
  return { text: lines.join('\n'), images }
}

function flattenContent(content: ChatContent, images: CursorImage[]): string {
  if (typeof content === 'string') return content.trim()
  const texts: string[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim()) texts.push(part.text.trim())
      continue
    }
    const image = toCursorImage(part.image_url.url)
    if (image && images.length < 5) images.push(image)
    else texts.push('[图片]')
  }
  return texts.join('\n').trim()
}

function toCursorImage(url: string): CursorImage | undefined {
  const data = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url.trim())
  if (data?.[1] && data[2]) return { mimeType: data[1].toLowerCase(), data: data[2].replace(/\s+/g, '') }
  if (/^https?:\/\//i.test(url.trim())) return { url: url.trim() }
  return undefined
}

async function createRun(
  request: ChatRequest,
  apiKey: string,
  prompt: { text: string; images: CursorImage[] },
  fetchImpl: typeof fetch,
): Promise<CreatedRun> {
  let response: Response
  try {
    response = await cursorFetch(
      agentUrl(request.baseUrl, ''),
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '工作台对话',
          prompt: {
            text: prompt.text,
            ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
          },
          model: modelSelection(request.model),
        }),
      },
      CREATE_TIMEOUT_MS,
      fetchImpl,
      request.signal,
    )
  } catch (error) {
    if (error instanceof LlmError && error.status === 404) {
      throw new LlmError(
        'Cursor 没有 OpenAI 的对话接口。',
        'http',
        '已改走 Cloud Agent，但这次创建失败。请确认 API Key 可以创建无仓库的 Cloud Agent。',
        404,
      )
    }
    throw error
  }
  const body = await response.json().catch(() => null)
  const record = body && typeof body === 'object' ? (body as { agent?: { id?: unknown }; run?: { id?: unknown } }) : {}
  const agentId = typeof record.agent?.id === 'string' ? record.agent.id : ''
  const runId = typeof record.run?.id === 'string' ? record.run.id : ''
  if (!agentId || !runId) throw new LlmError('Cursor 没有返回对话任务。', 'parse')
  log('info', 'llm', 'Cursor 云端对话已创建', { model: request.model, agentId, runId })
  return { agentId, runId }
}

function modelSelection(model: string): { id: string; params?: Array<{ id: string; value: string }> } {
  if (model === 'auto-smart') return { id: model, params: [{ id: 'optimize_for', value: 'balanced' }] }
  return { id: model }
}

async function disposeRun(
  baseUrl: string,
  apiKey: string,
  created: CreatedRun,
  fetchImpl: typeof fetch,
  cancel: boolean,
): Promise<void> {
  if (cancel) {
    await fetchImpl(
      agentUrl(baseUrl, `/${encodeURIComponent(created.agentId)}/runs/${encodeURIComponent(created.runId)}/cancel`),
      { method: 'POST', headers: authHeaders(apiKey), signal: AbortSignal.timeout(10_000) },
    ).catch(() => undefined)
  }
  const response = await fetchImpl(agentUrl(baseUrl, `/${encodeURIComponent(created.agentId)}`), {
    method: 'DELETE',
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    log('warn', 'llm', 'Cursor 云端对话清理失败', {
      agentId: created.agentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  })
  if (response && !response.ok) {
    log('warn', 'llm', 'Cursor 云端对话清理失败', { agentId: created.agentId, status: response.status })
  }
}

function agentUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return `${base}/agents${suffix}`
}

function authHeaders(apiKey: string): Record<string, string> {
  return { accept: 'application/json', authorization: `Bearer ${apiKey}` }
}

async function cursorFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetchImpl(url, { ...init, signal: combined })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpError(response.status, text)
    }
    return response
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (signal?.aborted) throw new LlmError('请求已取消。', 'abort')
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new LlmError('请求超时。', 'timeout', 'Cursor 云端对话还没结束。可以再发一次。')
    }
    log('warn', 'llm', 'Cursor 云端对话失败', { url, error: error instanceof Error ? error.message : String(error) })
    throw new LlmError('连不上 Cursor。', 'network', '请确认 API Key 仍然有效，以及这台电脑能访问 api.cursor.com。')
  }
}

type SseEvent = { event: string; json: Record<string, unknown> }

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const event = parseSseBlock(block)
      if (event) yield event
    }
  }
  const tail = parseSseBlock(buffer)
  if (tail) yield tail
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  try {
    const json = JSON.parse(dataLines.join('\n')) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null
    return { event, json: json as Record<string, unknown> }
  } catch {
    return null
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function unseenSuffix(full: string, seen: string): string {
  if (!full || full === seen || seen.startsWith(full)) return ''
  if (full.startsWith(seen)) return full.slice(seen.length)
  return ''
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new LlmError('请求已取消。', 'abort')
}
