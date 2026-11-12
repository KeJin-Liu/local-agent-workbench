import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  MAIL_POLL_TASK_ID,
  MAIL_POLL_TASK_KIND,
  MAIL_SYSTEM_DESCRIPTION,
  assertMailReady,
  buildWorkInstructionText,
  createMailInstructionService,
  ensureOwnerMailPollTask,
  isMailPollTask,
  runMailPollPipeline,
  summarizeMailPollRun,
} from '../src/app/mail-instructions.ts'
import { createTaskService } from '../src/app/tasks.ts'
import { createConversation } from '../src/app/conversations.ts'
import { updateAppSettings } from '../src/app/settings.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { OWNER_FRIEND_ID } from '../src/storage/schema.ts'

describe('p1.3.1 邮箱应用拉信 → 下发会话', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  async function freshDb() {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-p131-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    return { database, repos }
  }

  async function enableMail(database: Awaited<ReturnType<typeof freshDb>>['database']) {
    await updateAppSettings(database, {
      mailInstructions: {
        enabled: true,
        whitelist: ['boss@example.com'],
        pollIntervalMinutes: 10,
        imap: {
          host: 'imap.example.com',
          port: 993,
          tls: true,
          username: 'bot@example.com',
          vaultEntryId: 'vault-imap',
        },
        smtp: {
          host: 'smtp.example.com',
          port: 465,
          tls: true,
          username: 'bot@example.com',
          vaultEntryId: 'vault-smtp',
        },
      },
    })
    return ensureOwnerMailPollTask(database)
  }

  it('MAIL_POLL 任务 kind=system_mail_poll；isMailPollTask 识别', async () => {
    const { database } = await freshDb()
    const task = await enableMail(database)
    assert.equal(task.id, MAIL_POLL_TASK_ID)
    assert.equal(task.kind, MAIL_POLL_TASK_KIND)
    assert.equal(task.prompt, MAIL_SYSTEM_DESCRIPTION)
    assert.equal(isMailPollTask(task), true)
    assert.equal(isMailPollTask({ id: 'other', kind: 'prompt' }), false)
    assert.equal(isMailPollTask({ id: 'x', kind: 'system_mail_poll' }), true)
  })

  it('缺凭证 / 未启用：人话失败，不调 fetch/dispatch/chat', async () => {
    const { database, repos } = await freshDb()
    await updateAppSettings(database, {
      mailInstructions: {
        enabled: false,
        whitelist: ['a@b.com'],
        imap: { host: 'h', port: 993, tls: true, username: 'u', vaultEntryId: 'v' },
        smtp: { host: 'h', port: 465, tls: true, username: 'u', vaultEntryId: 'v' },
      },
    })
    const task = await ensureOwnerMailPollTask(database)
    let fetched = 0
    let dispatched = 0
    await assert.rejects(
      () =>
        runMailPollPipeline({
          database,
          repos,
          task,
          fetchInbox: async () => {
            fetched += 1
            return []
          },
          sendSmtp: async () => {},
          dispatch: async () => {
            dispatched += 1
            return { ok: true, summary: 'nope' }
          },
        }),
      /未启用/,
    )
    assert.equal(fetched, 0)
    assert.equal(dispatched, 0)

    await updateAppSettings(database, {
      mailInstructions: {
        enabled: true,
        whitelist: ['a@b.com'],
        imap: { host: 'imap.example.com', port: 993, tls: true, username: 'bot', vaultEntryId: undefined },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, username: 'bot', vaultEntryId: 'vault-smtp' },
      },
    })
    const conf = (await database.read()).settings!.mailInstructions
    await assert.rejects(() => Promise.resolve().then(() => assertMailReady(conf)), /IMAP 密码凭证/)
  })

  it('runner 对 MAIL_POLL 走 mail pipeline；白名单进会话触发；非白名单不进；SMTP mock 调用', async () => {
    const { database, repos } = await freshDb()
    await enableMail(database)
    const conversation = await createConversation(repos, '群主', {
      kind: 'direct',
      friendIds: [OWNER_FRIEND_ID],
    })
    await database.update((doc) => {
      const row = doc.stores.tasks.find((item) => item.id === MAIL_POLL_TASK_ID)
      if (row) row.targetConversationId = conversation.id
    })
    const refreshed = (await database.read()).stores.tasks.find((item) => item.id === MAIL_POLL_TASK_ID)!

    const dispatched: string[] = []
    const smtp: Array<{ to: string; body: string }> = []
    let chatCalled = 0

    const tasks = createTaskService(database, async (current, signal) => {
      if (!isMailPollTask(current)) {
        chatCalled += 1
        return `prompt:${current.prompt}`
      }
      return runMailPollPipeline({
        database,
        repos,
        task: current,
        signal,
        fetchInbox: async () => [
          { id: 'm-skip', from: 'stranger@example.com', subject: '广告', body: 'buy' },
          { id: 'm-ok', from: 'boss@example.com', subject: '周报', body: '请生成本周周报' },
        ],
        sendSmtp: async (input) => {
          smtp.push({ to: input.to, body: input.body })
        },
        dispatch: async ({ mail, conversationId, instructionText }) => {
          assert.equal(conversationId, conversation.id)
          assert.match(instructionText, /【邮件工作指令】/)
          assert.match(instructionText, /boss@example.com/)
          assert.match(instructionText, /请生成本周周报/)
          dispatched.push(mail.id)
          return { ok: true, summary: '已下发并完成编排' }
        },
      })
    })

    const after = await tasks.run(MAIL_POLL_TASK_ID)
    assert.equal(after.lastStatus, 'success')
    assert.equal(chatCalled, 0)
    assert.deepEqual(dispatched, ['m-ok'])
    assert.equal(smtp.length, 1)
    assert.equal(smtp[0]?.to, 'boss@example.com')
    assert.match(smtp[0]!.body, /执行成功/)
    assert.doesNotMatch(smtp[0]!.body, /没有邮箱|邮箱工具|tool_call/)
    assert.match(after.history[0]?.result || '', /拉取 2/)
    assert.match(after.history[0]?.result || '', /执行 1/)
    assert.match(after.history[0]?.result || '', /跳过 1/)
    assert.doesNotMatch(after.history[0]?.result || '', /没有邮箱|邮箱工具/)

    const processed = (await database.read()).stores.processedMails
    assert.equal(processed.find((item) => item.id === 'm-skip')?.status, 'skipped')
    assert.equal(processed.find((item) => item.id === 'm-ok')?.status, 'executed')
    assert.ok(refreshed)
  })

  it('普通自动化任务仍走 prompt 路径', async () => {
    const { database } = await freshDb()
    let promptHits = 0
    let mailHits = 0
    const tasks = createTaskService(database, async (task) => {
      if (isMailPollTask(task)) {
        mailHits += 1
        return 'mail'
      }
      promptHits += 1
      return `ok:${task.prompt}`
    })
    const created = await tasks.upsert({
      name: '日常问候',
      friendId: OWNER_FRIEND_ID,
      prompt: '说你好',
      schedule: 'manual',
      kind: 'prompt',
    })
    assert.equal(created.kind, 'prompt')
    const after = await tasks.run(created.id)
    assert.equal(after.lastStatus, 'success')
    assert.equal(after.history[0]?.result, 'ok:说你好')
    assert.equal(promptHits, 1)
    assert.equal(mailHits, 0)
  })

  it('工作指令文案与摘要不含模型推脱', () => {
    const text = buildWorkInstructionText({
      id: '1',
      from: 'a@b.com',
      subject: 'x',
      body: '做这件事',
    })
    assert.match(text, /【邮件工作指令】/)
    assert.match(text, /做这件事/)
    const summary = summarizeMailPollRun({
      fetched: 3,
      results: [
        { mailId: '1', from: 'a', subject: 's1', status: 'executed', resultSummary: 'ok' },
        { mailId: '2', from: 'b', subject: 's2', status: 'skipped', reason: '发件人不在白名单' },
        { mailId: '3', from: 'c', subject: 's3', status: 'failed', reason: 'SMTP 超时' },
      ],
    })
    assert.match(summary, /拉取 3/)
    assert.match(summary, /执行 1/)
    assert.match(summary, /跳过 1/)
    assert.match(summary, /失败 1/)
    assert.doesNotMatch(summary, /没有邮箱工具/)
  })

  it('createMailInstructionService 仍支持 processInbox 覆盖 execute', async () => {
    const { database } = await freshDb()
    await enableMail(database)
    const mail = createMailInstructionService(database)
    const seen: string[] = []
    const results = await mail.processInbox(
      [{ id: 'z1', from: 'boss@example.com', subject: 'T', body: 'body' }],
      undefined,
      async (item) => {
        seen.push(item.id)
        return { ok: true, summary: 'done' }
      },
    )
    assert.deepEqual(seen, ['z1'])
    assert.equal(results[0]?.status, 'executed')
  })
})
