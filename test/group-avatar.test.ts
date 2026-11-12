/**
 * 群头像：设置 / 更换 / 恢复默认，列表与另起线程都要带上；非法头像被拒绝。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { createHost } from '../src/server.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('群头像', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('UI 接线：群设置可上传/恢复默认，列表与聊天顶栏显示群头像', async () => {
    const list = await readFile(path.join(root, 'src/ui/conversation-list.tsx'), 'utf8')
    assert.match(list, /群头像/)
    assert.match(list, /uploadAvatar\(file\)/)
    assert.match(list, /restore|恢复默认/)
    assert.match(list, /row\.conversation\?\.avatar/)

    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /<Avatar avatar=\{current\.avatar\} name="群"/)

    const app = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8')
    assert.match(app, /avatar: selected\.avatar/)
    assert.match(app, /群头像没有写入本地库/)
    assert.match(list, /头像还在上传/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.group-avatar-row/)
    assert.match(css, /\.group-avatar-actions/)
  })

  it('可设置/更换/恢复默认；另起线程保留；非法头像拒绝', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-group-avatar-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      mediaDir: path.join(directory, 'media'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    const owner = workbench.friends.find((item: { isOwnerTemplate: boolean }) => item.isOwnerTemplate)
    const devResponse = await fetch(`${base}/api/friends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '群头像验收好友',
        description: '测试',
        systemPrompt: '',
        avatar: owner.avatar,
        providerId: owner.providerId,
        defaultModelId: owner.defaultModelId ?? 'mock-model',
      }),
    })
    const dev = (await devResponse.json()).friend
    assert.ok(dev?.id)

    const createResponse = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '群头像验收',
        kind: 'group',
        friendIds: [owner.id, dev.id],
        avatar: { kind: 'default', id: 'moon', path: '/avatars/defaults/moon.svg' },
      }),
    })
    const created = await createResponse.json()
    assert.equal(createResponse.status, 201)
    assert.equal(created.conversation.avatar.kind, 'default')
    assert.equal(created.conversation.avatar.id, 'moon')
    const groupId = created.conversation.id as string

    const listed = await (await fetch(`${base}/api/workbench`)).json()
    const row = listed.conversations.find((item: { id: string }) => item.id === groupId)
    assert.equal(row?.avatar?.id, 'moon')

    const uploaded = await uploadAvatar(base, png, 'group.png', 'image/png')
    assert.equal(uploaded.ok, true)
    const uploadAvatarValue = uploaded.avatar!
    const replace = await fetch(`${base}/api/conversations/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '群头像验收',
        friendIds: [owner.id, dev.id],
        avatar: uploadAvatarValue,
      }),
    })
    const replaced = await replace.json()
    assert.equal(replace.status, 200)
    assert.equal(replaced.conversation.avatar.kind, 'upload')
    assert.equal(replaced.conversation.avatar.id, uploadAvatarValue.id)

    const fresh = await (
      await fetch(`${base}/api/conversations/${encodeURIComponent(groupId)}/new-chat`, { method: 'POST' })
    ).json()
    assert.equal(fresh.conversation.avatar.id, uploadAvatarValue.id)

    const reset = await fetch(`${base}/api/conversations/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '群头像验收', friendIds: [owner.id, dev.id], avatar: null }),
    })
    const resetBody = await reset.json()
    assert.equal(reset.status, 200)
    assert.equal(resetBody.conversation.avatar, undefined)

    const invalid = await fetch(`${base}/api/conversations/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '群头像验收',
        friendIds: [owner.id, dev.id],
        avatar: { kind: 'default', id: 'not-exist', path: '/avatars/defaults/not-exist.svg' },
      }),
    })
    assert.equal(invalid.status, 400)

    const tampered = await fetch(`${base}/api/conversations/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '群头像验收',
        friendIds: [owner.id, dev.id],
        avatar: { kind: 'upload', id: uploadAvatarValue.id, path: '/avatars/files/../../package.json' },
      }),
    })
    assert.equal(tampered.status, 400)
  })
})

async function uploadAvatar(base: string, data: Buffer, filename: string, type: string) {
  const boundary = '----workbench-group-avatar'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const response = await fetch(`${base}/api/avatars`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  return (await response.json()) as {
    ok: boolean
    avatar?: { kind: 'upload'; id: string; path: string }
    message?: string
  }
}
