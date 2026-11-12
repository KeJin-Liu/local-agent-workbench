/**
 * 轻量 Markdown → React（气泡用）。解析在 markdown-core；此处只做视图。
 */

import { createElement, type ReactNode } from 'react'
import { parseMarkdown, type MdBlock, type MdInline } from './markdown-core.ts'

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  )
}

function renderBlock(block: MdBlock, key: number): ReactNode {
  if (block.type === 'code') {
    return (
      <pre key={key} className="md-code">
        <code>{block.body}</code>
      </pre>
    )
  }
  if (block.type === 'ul') {
    return (
      <ul key={key} className="md-list">
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>
    )
  }
  if (block.type === 'ol') {
    return (
      <ol key={key} className="md-list">
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ol>
    )
  }
  if (block.type === 'quote') {
    return (
      <blockquote key={key} className="md-quote">
        {renderInline(block.children)}
      </blockquote>
    )
  }
  if (block.type === 'heading') {
    return createElement(`h${block.level}`, { key, className: 'md-h' }, renderInline(block.children))
  }
  return (
    <p key={key} className="md-p">
      {renderInline(block.children)}
    </p>
  )
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((node, key) => {
    if (node.type === 'text') return node.value
    if (node.type === 'code') {
      return (
        <code key={key} className="md-inline-code">
          {node.value}
        </code>
      )
    }
    if (node.type === 'strong') return <strong key={key}>{renderInline(node.children)}</strong>
    if (node.type === 'em') return <em key={key}>{renderInline(node.children)}</em>
    return (
      <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
        {node.value}
      </a>
    )
  })
}
