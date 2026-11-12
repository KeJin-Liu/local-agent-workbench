import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { pickFolder } from '../src/app/folder-picker.ts'
import { createHost } from '../src/server.ts'

describe('p1.2 工作目录选文件夹', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('注入 picker 返回绝对路径；取消返回 cancelled', async () => {
    const picked = await pickFolder({ picker: async () => '/tmp/demo-workspace' })
    assert.equal(picked.cancelled, undefined)
    assert.equal(picked.path, '/tmp/demo-workspace')

    const cancelled = await pickFolder({ picker: async () => null })
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.path, null)
  })

  it('POST /api/workspace/pick-folder 走注入/mock 路径', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-pick-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      mediaDir: path.join(directory, 'media'),
      ui: 'none',
      port: 0,
      sendDelayMs: 0,
    })
    cleanup.push(async () => host.close())
    // monkey-patch via env mock for host path without folderPicker on ctx —
    // host doesn't expose ctx; use WORKBENCH_MOCK_FOLDER
    process.env.WORKBENCH_MOCK_FOLDER = path.join(directory, 'picked-root')
    cleanup.push(async () => {
      delete process.env.WORKBENCH_MOCK_FOLDER
    })
    const res = await fetch(`http://127.0.0.1:${host.port}/api/workspace/pick-folder`, { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' }})
    const body = (await res.json()) as { ok: boolean; cancelled: boolean; path: string | null }
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.cancelled, false)
    assert.equal(body.path, path.join(directory, 'picked-root'))
  })
})
