import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('工具轨迹按 run 拆分且默认折叠', () => {
  it('CodeToolTimeline 默认收起', async () => {
    const cards = await readFile(path.join(root, 'src/ui/code-cards.tsx'), 'utf8')
    assert.match(cards, /useState\(false\)/)
    assert.match(cards, /工具时间线/)
  })

  it('会话按 runId 分组渲染 ToolTrackBlock，不再整表累积', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /function ToolTrackBlock/)
    assert.match(pane, /timelineByRun/)
    assert.match(pane, /entry\.runId \?\? '__orphan__'/)
    assert.match(pane, /isLastOfRun/)
    assert.match(pane, /ToolTrackBlock key=\{`track-\$\{message\.runId\}`\}/)
    assert.doesNotMatch(pane, /<CodeToolTimeline events=\{codeTimeline\} \/>/)
  })
})
