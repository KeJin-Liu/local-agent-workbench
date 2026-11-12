/**
 * 模型客户端的错误。页面要能区分「连不上」「HTTP 失败」和「响应不像 OpenAI」。
 */

export type LlmErrorCode = 'network' | 'http' | 'parse' | 'abort' | 'timeout'

export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly hint?: string
  readonly status?: number

  constructor(message: string, code: LlmErrorCode, hint?: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.hint = hint
    this.status = status
  }
}

/**
 * 探测是 Node 代发的，浏览器 CORS 拦不住。
 * OLLAMA_ORIGINS 仍要写清楚：只有网页自己直接请求 Ollama 时才需要它。
 */
export const CONNECTION_HINT =
  '连不上这个地址。请确认本机模型服务已启动（例如先打开 Ollama），再到设置里重新探测。'

/** 把 HTTP 状态翻成能放进页面的错误。 */
export function httpError(status: number, body: string): LlmError {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 180)
  const message = snippet ? `接口返回 ${status}：${snippet}` : `接口返回 ${status}。`
  let hint: string | undefined
  if (status === 404) {
    hint = '没有找到模型列表。请确认地址以 /v1 结尾，例如 http://127.0.0.1:11434/v1。'
  } else if (status === 401 || status === 403) {
    hint = '服务拒绝了访问。如果它要求密钥，在 API Key 里填上后再探测。本地 Ollama 通常留空。'
  }
  return new LlmError(message, 'http', hint, status)
}
