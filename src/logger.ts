/**
 * 单行 JSON 日志。按 level、module，以及 conversationId / runId 过滤。
 * 只写控制台，不把密钥打出去。
 */

const SENSITIVE_KEY = /^(api[-_]?key|authorization|password|secret|token|credential)$/i

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * @param level 严重程度
 * @param moduleName 模块名，例如 storage、http、llm
 * @param message 人能读的短句
 * @param fields 附加字段。apiKey 等会被打成 [redacted]
 */
export function log(
  level: LogLevel,
  moduleName: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    module: moduleName,
    message,
  }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      entry[key] = redactValue(key, value)
    }
  }
  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

/** 字段名像密钥，或字符串本身像密钥 / Bearer，都换成占位符。原始 apiKey 不能进日志。 */
export function redactValue(key: string, value: unknown): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    if (/^sk[-_]/i.test(value) || /bearer\s+\S+/i.test(value)) return '[redacted]'
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactValue('', item))
  if (value && typeof value === 'object') {
    const nested: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value)) {
      if (child === undefined) continue
      nested[childKey] = redactValue(childKey, child)
    }
    return nested
  }
  return value
}
