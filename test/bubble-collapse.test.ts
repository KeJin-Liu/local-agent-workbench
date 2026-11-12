import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('聊天历史气泡三行折叠', () => {
  it('CollapsibleBubble 接入消息气泡，并带展开/收起与 is-collapsed 样式', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /function CollapsibleBubble/)
    assert.match(pane, /bubble-collapse/)
    assert.match(pane, /is-collapsed/)
    assert.match(pane, /forceExpanded/)
    assert.match(pane, /messages\.at\(-1\)\?\.id/)
    assert.match(pane, /展开/)
    assert.match(pane, /收起/)
    assert.match(pane, /BUBBLE_COLLAPSE_MAX_PX/)
    assert.match(pane, /<CollapsibleBubble forceExpanded=\{forceExpanded\} resetKey=\{message\.id\}>/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.bubble-collapse\.is-collapsed/)
    assert.match(css, /\.bubble-collapse-fade/)
    assert.match(css, /\.bubble-collapse-toggle/)
  })
})
