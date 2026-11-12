/**
 * 轻量 Markdown 解析（无 React）。气泡用；测试直接断言 AST，避免 node 加载 .tsx。
 */

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; value: string }
  | { type: 'a'; href: string; value: string }

export type MdBlock =
  | { type: 'code'; lang: string; body: string }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'quote'; children: MdInline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: MdInline[] }
  | { type: 'p'; children: MdInline[] }

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', lang, body: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!),
      })
      i += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) })
      continue
    }
    if (/^\s*([-*•])\s+/.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\s*([-*•])\s+/, '')))
        i += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')))
        i += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }
    const body: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current.trim() === '' ||
        /^```/.test(current) ||
        /^#{1,3}\s+/.test(current) ||
        /^>\s?/.test(current) ||
        /^\s*([-*•])\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current)
      ) {
        break
      }
      body.push(current)
      i += 1
    }
    blocks.push({ type: 'p', children: parseInline(body.join('\n')) })
  }
  return blocks
}

export function parseInline(source: string): MdInline[] {
  const nodes: MdInline[] = []
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (match.index > last) nodes.push({ type: 'text', value: source.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push({ type: 'code', value: token.slice(1, -1) })
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) })
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push({ type: 'em', children: parseInline(token.slice(1, -1)) })
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        nodes.push({ type: 'a', href: sanitizeHref(link[2]!), value: link[1]! })
      } else {
        nodes.push({ type: 'text', value: token })
      }
    } else {
      nodes.push({ type: 'text', value: token })
    }
    last = match.index + token.length
  }
  if (last < source.length) nodes.push({ type: 'text', value: source.slice(last) })
  return nodes
}

/** 扁平文本，用于断言「不残留 **粗体**」 */
export function markdownPlainText(source: string): string {
  return flattenBlocks(parseMarkdown(source))
}

function flattenBlocks(blocks: MdBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'code') return block.body
      if (block.type === 'ul' || block.type === 'ol') return block.items.map(flattenInline).join('\n')
      if (block.type === 'quote' || block.type === 'heading' || block.type === 'p') return flattenInline(block.children)
      return ''
    })
    .join('\n')
}

function flattenInline(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'code' || node.type === 'a') return node.value
      return flattenInline(node.children)
    })
    .join('')
}

function sanitizeHref(href: string): string {
  const trimmed = href.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  return '#'
}
