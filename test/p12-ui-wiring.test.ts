import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createHost } from '../src/server.ts'
import { OWNER_FRIEND_ID } from '../src/storage/schema.ts'

describe('p1.2 UI 接线 API', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  async function boot() {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-p12-ui-'))
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
    const base = `http://127.0.0.1:${host.port}`
    return { base, directory }
  }

  it('composer patch + plan draft/confirm + settings mail/prompt', async () => {
    const { base, directory } = await boot()
    const wb = await fetch(`${base}/api/workbench`).then((r) => r.json()) as {
      conversations: Array<{ id: string; friendIds: string[] }>
    }
    let conversationId = wb.conversations.find(
      (item) => item.friendIds.length === 1 && item.friendIds[0] === OWNER_FRIEND_ID,
    )?.id
    if (!conversationId) {
      const created = await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '群主', friendIds: [OWNER_FRIEND_ID], kind: 'direct' }),
      }).then((r) => r.json()) as { conversation: { id: string } }
      conversationId = created.conversation.id
    }

    const patched = await fetch(`${base}/api/conversations/${conversationId}/composer`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatMode: 'plan', reasoningLevel: 'high' }),
    }).then((r) => r.json()) as { ok: boolean; conversation: { chatMode: string; reasoningLevel: string } }
    assert.equal(patched.ok, true)
    assert.equal(patched.conversation.chatMode, 'plan')
    assert.equal(patched.conversation.reasoningLevel, 'high')

    const planRoot = path.join(directory, 'plans')
    // draft via API uses default /tmp/agent-workbench/plans — still ok for acceptance
    const drafted = await fetch(`${base}/api/conversations/${conversationId}/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '邮箱工作指令',
        steps: ['拉取邮件', '过滤白名单', '回结果'],
        goal: '落地 IMAP 白名单',
      }),
    }).then((r) => r.json()) as { ok: boolean; plan: { id: string; status: string; filePath: string } }
    assert.equal(drafted.ok, true)
    assert.equal(drafted.plan.status, 'awaiting_confirm')
    const md = await readFile(drafted.plan.filePath, 'utf8')
    assert.match(md, /验收标准/)
    assert.match(md, /- \[ \] 拉取邮件/)

    const confirmed = await fetch(`${base}/api/plans/${drafted.plan.id}/confirm`, { method: 'POST' }).then((r) =>
      r.json(),
    ) as { plan: { status: string } }
    assert.equal(confirmed.plan.status, 'executing')

    const settings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planModePrompt: 'CUSTOM_PROMPT {{planPath}}',
        mailInstructions: {
          enabled: true,
          whitelist: ['owner@example.com'],
          pollIntervalMinutes: 10,
          taskPrompt: 'CUSTOM_MAIL_PROMPT：无人值守完成并回信。',
          autoConfirm: false,
          imap: { host: 'imap.163.com', port: 993, tls: true, username: 'a@163.com' },
          smtp: { host: 'smtp.163.com', port: 465, tls: true, username: 'a@163.com' },
        },
      }),
    }).then((r) => r.json()) as {
      settings: {
        planModePrompt: string
        mailInstructions: {
          enabled: boolean
          whitelist: string[]
          taskPrompt: string
          autoConfirm: boolean
        }
      }
    }
    assert.match(settings.settings.planModePrompt, /CUSTOM_PROMPT/)
    assert.equal(settings.settings.mailInstructions.enabled, true)
    assert.deepEqual(settings.settings.mailInstructions.whitelist, ['owner@example.com'])
    assert.match(settings.settings.mailInstructions.taskPrompt, /CUSTOM_MAIL_PROMPT/)
    assert.equal(settings.settings.mailInstructions.autoConfirm, false)

    const tasks = await fetch(`${base}/api/tasks`).then((r) => r.json()) as {
      tasks: Array<{ id: string; name: string }>
    }
    assert.ok(tasks.tasks.some((item) => item.id === 'task-mail-work-instructions'))
    void planRoot
  })

  it('群聊选择的模型和提供方刷新后仍在会话上', async () => {
    const { base } = await boot()
    const wb = await fetch(`${base}/api/workbench`).then((response) => response.json()) as {
      providers: Array<{ id: string; enabled: boolean; defaultModel?: string; probedModels?: string[] }>
      friends: Array<{ id: string; isOwnerTemplate?: boolean; avatar: { kind: string; id?: string; path?: string } }>
    }
    const owner = wb.friends.find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const provider = wb.providers[0]
    assert.ok(provider)
    const model = 'group-remembered-model'
    const friend = await fetch(`${base}/api/friends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '群成员', providerId: provider.id, defaultModelId: model, avatar: owner.avatar }),
    }).then((response) => response.json()) as { friend: { id: string } }

    const created = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '模型记忆群', friendIds: [owner.id, friend.friend.id], kind: 'group' }),
    }).then((response) => response.json()) as { conversation: { id: string } }

    const patched = await fetch(`${base}/api/conversations/${created.conversation.id}/composer`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, providerId: provider.id }),
    }).then((response) => response.json()) as {
      ok: boolean
      conversation: { model?: string; providerId: string }
    }
    assert.equal(patched.ok, true)
    assert.equal(patched.conversation.model, model)
    assert.equal(patched.conversation.providerId, provider.id)

    const again = await fetch(`${base}/api/workbench`).then((response) => response.json()) as {
      conversations: Array<{ id: string; model?: string; providerId: string }>
    }
    const saved = again.conversations.find((item) => item.id === created.conversation.id)
    assert.equal(saved?.model, model)
    assert.equal(saved?.providerId, provider.id)
  })
})
