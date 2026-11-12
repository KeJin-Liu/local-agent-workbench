import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('会话顶栏', () => {
  it('不再提供删除会话按钮；记忆与摘要入口保留', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.doesNotMatch(pane, /确认删除/)
    assert.doesNotMatch(pane, /onDelete/)
    assert.match(pane, /查看摘要/)
    assert.match(pane, /管理记忆/)
    assert.match(pane, /复制会话 ID/)
    assert.match(pane, /copyConversationId/)

    const app = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8')
    assert.doesNotMatch(app, /onDelete=/)
  })

  it('保存为技能 / 新会话靠右，旁边有可切回的会话列表', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /className="ctb-right"/)
    assert.match(pane, /会话列表/)
    assert.match(pane, /conversationSegments/)
    assert.match(pane, /onSwitchConversation/)
    assert.match(pane, /formatSegmentTime/)

    const app = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8')
    assert.match(app, /onSwitchConversation=/)
    assert.match(app, /conversations={conversations}/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.ctb-right/)
    assert.match(css, /\.ctb-session-menu/)
  })
})
