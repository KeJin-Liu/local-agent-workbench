/**
 * p0.6：富媒体上传、静态取回、发送带附件消息；纯文字路径不变。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createHost } from '../src/server.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('p0.6 富媒体', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('上传图/文件、取静态、带附件发送；纯文字仍可发', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-p06-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      mediaDir: path.join(directory, 'media'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
      sendDelayMs: 30_000,
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    const conversationId = workbench.conversations[0].id as string

    const uploaded = await upload(base, png, 'pixel.png', 'image/png')
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.attachment.kind, 'image')
    assert.match(uploaded.attachment.path, /^\/media\/files\//)

    const fileRes = await fetch(`${base}${uploaded.attachment.path}`)
    assert.equal(fileRes.status, 200)
    assert.match(fileRes.headers.get('content-type') ?? '', /image\/png/)
    assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff')

    const note = await upload(base, Buffer.from('# hello\n'), 'notes.md', 'text/markdown')
    assert.equal(note.ok, true)
    assert.equal(note.attachment.kind, 'file')
    const dl = await fetch(`${base}${note.attachment.path}?download=1`)
    assert.equal(dl.status, 200)
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/)

    const traversal = await fetch(`${base}/media/files/..%2F..%2Fpackage.json`)
    assert.equal(traversal.status, 404)

    const rejected = await upload(
      base,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      'x.svg',
      'image/svg+xml',
    )
    assert.equal(rejected.ok, false)

    // 纯文字路径不变
    const textOnly = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '只发文字', model: 'mock-model', delayMs: 60_000 }),
    })
    const textBody = await textOnly.json()
    assert.equal(textOnly.status, 201)
    assert.equal(textBody.message.content, '只发文字')
    assert.equal(textBody.message.attachments, undefined)
    await fetch(`${base}/api/runs/${encodeURIComponent(textBody.run.id)}/cancel`, { method: 'POST' })

    // 带附件发送（可无文字）
    const withMedia = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '看图',
        model: 'mock-model',
        attachmentIds: [uploaded.attachment.id, note.attachment.id],
        delayMs: 60_000,
      }),
    })
    const mediaBody = await withMedia.json()
    assert.equal(withMedia.status, 201, mediaBody.message || JSON.stringify(mediaBody))
    assert.equal(mediaBody.message.content, '看图')
    assert.equal(mediaBody.message.attachments.length, 2)
    assert.equal(mediaBody.message.attachments[0].kind, 'image')
    assert.equal(mediaBody.message.attachments[1].kind, 'file')

    const thread = await (await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/thread`)).json()
    const found = thread.messages.find((item: { id: string }) => item.id === mediaBody.message.id)
    assert.ok(found)
    assert.equal(found.attachments.length, 2)

    await fetch(`${base}/api/runs/${encodeURIComponent(mediaBody.run.id)}/cancel`, { method: 'POST' })

    // 仅附件、无文字也可发
    const onlyAtt = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '',
        model: 'mock-model',
        attachmentIds: [uploaded.attachment.id],
        delayMs: 60_000,
      }),
    })
    const onlyBody = await onlyAtt.json()
    assert.equal(onlyAtt.status, 201, onlyBody.message || JSON.stringify(onlyBody))
    assert.equal(onlyBody.message.content, '')
    assert.equal(onlyBody.message.attachments.length, 1)
    await fetch(`${base}/api/runs/${encodeURIComponent(onlyBody.run.id)}/cancel`, { method: 'POST' })
  })
})

async function upload(base: string, data: Buffer, filename: string, type: string) {
  const boundary = '----workbench-p06'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const response = await fetch(`${base}/api/media`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  return (await response.json()) as {
    ok: boolean
    attachment: { id: string; kind: string; path: string; name: string }
    message?: string
  }
}
