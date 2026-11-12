import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { clampSendWaitSeconds, getAppSettings, updateAppSettings } from '../src/app/settings.ts'
import { createHost } from '../src/server.ts'
import { createOrchestrator, resolveSendDelayMs } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('p1.1.1/1.1.2 设置与发送等待', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('clampSendWaitSeconds 收成 1–10，非法回 5', () => {
    assert.equal(clampSendWaitSeconds(3), 3)
    assert.equal(clampSendWaitSeconds(1), 1)
    assert.equal(clampSendWaitSeconds(10), 10)
    assert.equal(clampSendWaitSeconds(0), 1)
    assert.equal(clampSendWaitSeconds(99), 10)
    assert.equal(clampSendWaitSeconds(3.6), 4)
    assert.equal(clampSendWaitSeconds('7'), 7)
    assert.equal(clampSendWaitSeconds('nope'), 5)
    assert.equal(clampSendWaitSeconds(undefined), 5)
  })

  it('GET/PUT /api/settings 读写并 clamp', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-settings-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
      sendDelayMs: 0,
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    assert.equal(workbench.settings.sendWaitSeconds, 5)

    const got = await (await fetch(`${base}/api/settings`)).json()
    assert.equal(got.settings.sendWaitSeconds, 5)

    const put = await (
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sendWaitSeconds: 3 }),
      })
    ).json()
    assert.equal(put.settings.sendWaitSeconds, 3)

    const clamped = await (
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sendWaitSeconds: 99 }),
      })
    ).json()
    assert.equal(clamped.settings.sendWaitSeconds, 10)

    const again = await (await fetch(`${base}/api/settings`)).json()
    assert.equal(again.settings.sendWaitSeconds, 10)
  })

  it('发送 delay 读全局设置秒数×1000；宿主 sendDelayMs 仍可覆盖', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-delay-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    await updateAppSettings(database, { sendWaitSeconds: 2 })
    const repos = createRepos(database)

    const fromSettings = createOrchestrator({
      repos,
      resolveSettingsDelayMs: async () => (await getAppSettings(database)).sendWaitSeconds * 1000,
      fetchImpl: async () => new Response('{}'),
      remember: async () => undefined,
    })
    const conversation = await createConversation(repos, '等待')
    const sent = await fromSettings.sendTurn({ conversationId: conversation.id, text: 'hi', model: 'qwen' })
    assert.equal(sent.delayMs, 2000)
    await fromSettings.cancelRun(sent.run.id)
    fromSettings.dispose()

    const overridden = createOrchestrator({
      repos,
      delayMs: 0,
      resolveSettingsDelayMs: async () => 9000,
      fetchImpl: async () => new Response('{}'),
      remember: async () => undefined,
    })
    const conversation2 = await createConversation(repos, '等待2')
    const sent2 = await overridden.sendTurn({ conversationId: conversation2.id, text: 'hi2', model: 'qwen' })
    assert.equal(sent2.delayMs, 0)
    overridden.dispose()

    assert.equal(resolveSendDelayMs(undefined, 3000), 3000)
  })
})
