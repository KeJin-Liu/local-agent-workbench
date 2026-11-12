/**
 * 模型把工具调用写成普通文本时的识别与收口。
 * 例如 deepseek 系列偶尔输出 `< | | DSML | | calls>` / `invoke name="Bash"`，
 * 这些标记不会被工具循环执行，不能原样当成指派结果。
 */

const DSML_MARKER = /<\s*\|?[^>\n]{0,40}DSML/i
const TOOL_TAG = /<\s*\/?\s*(?:invoke|parameter|calls)\b/i

/** 结果里是否出现了未执行的工具调用文本。 */
export function hasToolMarkup(text: string): boolean {
  if (!text) return false
  return DSML_MARKER.test(text) || TOOL_TAG.test(text)
}

/** 从第一段工具标记开始截断，保留前面的自然语言计划。 */
export function stripToolMarkup(text: string): string {
  if (!text) return ''
  const index = firstToolMarkupIndex(text)
  if (index < 0) return text.trim()
  return text.slice(0, index).trim()
}

/**
 * 指派结果的最后一道收口：能留下前面的计划就留，整段都是工具文本时给一句人话。
 * 不把原始标记回流到群里。
 */
export function sanitizeAssignmentText(text: string): string {
  const source = (text ?? '').trim()
  if (!hasToolMarkup(source)) return source
  const head = stripToolMarkup(source)
  if (head.length >= 6) return head
  return '模型把工具调用写成了普通文本，系统没有执行（已隐藏原始标记）。请确认这位好友已绑定工作目录、并且模型支持 function tools 后再试。'
}

function firstToolMarkupIndex(text: string): number {
  const indexes = [text.search(DSML_MARKER), text.search(TOOL_TAG)].filter((index) => index >= 0)
  return indexes.length > 0 ? Math.min(...indexes) : -1
}
