import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.4 好友管理「取消」回聊天', () => {
  it('取消按钮丢弃本次编辑并交给上层路由，不落库', async () => {
    const friend = await readFile(path.join(root, 'src/ui/friend-panel.tsx'), 'utf8')

    assert.match(friend, /onCancel\?: \(\) => void/)
    assert.match(friend, /function cancelEdit\(\)/)

    const cancelBlock = friend.slice(friend.indexOf('function cancelEdit()'), friend.indexOf('const sortedFriends'))
    assert.match(cancelBlock, /setForm\(/)
    assert.match(cancelBlock, /onCancel\?\.\(\)/)
    assert.doesNotMatch(cancelBlock, /persist\(|requestJson/)

    assert.match(friend, /onClick=\{cancelEdit\}/)
  })

  it('App 把 FriendPanel 的取消接回聊天页，并清掉本次进入态', async () => {
    const app = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8')
    const panelStart = app.indexOf('<FriendPanel')
    const panelEnd = app.indexOf('/>', panelStart)
    const panel = app.slice(panelStart, panelEnd)

    assert.match(panel, /onCancel=\{\(\) => \{/)
    assert.match(panel, /setFriendFocus\(null\)/)
    assert.match(panel, /setFriendCreateToken\(0\)/)
    assert.match(panel, /setPage\('chat'\)/)
  })
})
