import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createHost } from '../src/server.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('本地 HTTP 宿主', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('种子、默认头像、上传和好友保存可以串起来', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-http-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    assert.deepEqual(workbench.db, { name: 'agent_workbench', version: 1 })
    assert.partialDeepStrictEqual(workbench.friends[0].avatar, { kind: 'default', id: 'seal' })

    const defaults = await (await fetch(`${base}/api/avatars/defaults`)).json()
    assert.ok(defaults.avatars.some((item: { id: string }) => item.id === 'crane'))
    const svg = await fetch(`${base}/avatars/defaults/seal.svg`)
    assert.equal(svg.status, 200)
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/)

    const traversal = await fetch(`${base}/avatars/files/..%2F..%2Fpackage.json`)
    assert.equal(traversal.status, 404)

    const uploaded = await upload(base, png, 'pixel.png', 'image/png')
    assert.equal(uploaded.avatar.kind, 'upload')
    const file = await fetch(`${base}${uploaded.avatar.path}`)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff')

    const saved = await fetch(`${base}/api/friends/role-owner`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '群主',
        description: '改过头像',
        systemPrompt: '仍然是群主',
        avatar: uploaded.avatar,
        vision: { enabled: true, providerId: 'ollama-local', modelId: 'vision-mock' },
      }),
    })
    const savedBody = await saved.json()
    assert.equal(savedBody.friend.avatar.kind, 'upload')
    assert.equal(savedBody.friend.isOwnerTemplate, true)
    assert.equal(savedBody.friend.vision.enabled, true)
    assert.equal(savedBody.friend.vision.modelId, 'vision-mock')

    const rejected = await upload(base, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.svg', 'image/svg+xml')
    assert.equal(rejected.ok, false)
  })

  it('探测会打到配置的 OpenAI 兼容地址', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-probe-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const stub = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-qwen', owned_by: 'local-mock' }] }))
        return
      }
      res.writeHead(404)
      res.end('missing')
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()))
    cleanup.push(() => new Promise((resolve) => stub.close(() => resolve())))
    const stubPort = (stub.address() as { port: number }).port

    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
    })
    cleanup.push(() => host.close())
    const response = await fetch(`http://127.0.0.1:${host.port}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${stubPort}/v1` }),
    })
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.models[0].id, 'mock-qwen')

    const bad = await fetch(`http://127.0.0.1:${host.port}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'file:///tmp/models' }),
    })
    assert.equal(bad.status, 400)
  })
})

async function upload(base: string, data: Buffer, filename: string, type: string) {
  const boundary = '----workbench-test'
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
  return (await response.json()) as { ok: boolean; avatar: { kind: string; path: string }; message?: string }
}


describe('p1.1 编码 HTTP', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('好友可绑定/清除 workspace；code-actions / timeline 路由可用', async () => {
    const { mkdtemp, rm, mkdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-http-code-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const ws = path.join(directory, 'ws')
    await mkdir(ws)

    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      mediaDir: path.join(directory, 'media'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
      sendDelayMs: 0,
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    const friendId = workbench.friends[0].id as string
    const providerId = workbench.friends[0].providerId as string
    const conversationId = workbench.conversations[0].id as string

    const bound = await (
      await fetch(`${base}/api/friends/${encodeURIComponent(friendId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: workbench.friends[0].name,
          description: workbench.friends[0].description,
          systemPrompt: workbench.friends[0].systemPrompt,
          providerId,
          avatar: workbench.friends[0].avatar,
          workspacePath: ws,
          codePermission: 'workspace-write',
        }),
      })
    ).json()
    assert.equal(bound.ok, true)
    assert.equal(bound.friend.workspacePath, ws)
    assert.equal(bound.friend.codePermission, 'workspace-write')

    const pending = await (
      await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/code-actions`)
    ).json()
    assert.equal(pending.ok, true)
    assert.deepEqual(pending.actions, [])

    const timeline = await (
      await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/code-timeline`)
    ).json()
    assert.equal(timeline.ok, true)
    assert.deepEqual(timeline.events, [])

    const missing = await fetch(`${base}/api/code-actions/not-a-real-id/confirm`, { method: 'POST' })
    const missingBody = await missing.json()
    assert.equal(missing.ok, false)
    assert.match(String(missingBody.message ?? ''), /确认卡|结束|不存在|找不到|已经结束/)

    const cleared = await (
      await fetch(`${base}/api/friends/${encodeURIComponent(friendId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bound.friend.name,
          description: bound.friend.description,
          systemPrompt: bound.friend.systemPrompt,
          providerId,
          avatar: bound.friend.avatar,
          workspacePath: '',
          codePermission: '',
        }),
      })
    ).json()
    assert.equal(cleared.ok, true)
    assert.equal(cleared.friend.workspacePath, undefined)
  })
})
