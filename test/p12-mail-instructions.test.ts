import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  MAIL_POLL_TASK_ID,
  buildResultSummary,
  createMailInstructionService,
  cronForPollMinutes,
  ensureOwnerMailPollTask,
  filterWhitelistedMails,
  isWhitelisted,
} from '../src/app/mail-instructions.ts'
import { getAppSettings, updateAppSettings } from '../src/app/settings.ts'
import { DEFAULT_MAIL_TASK_PROMPT, normalizeMailSettings } from '../src/storage/schema.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('p1.2 邮箱工作指令', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('邮件工作提示词有默认模板；旧配置默认自动执行，空白回默认', () => {
    const base = normalizeMailSettings({})
    assert.equal(base.autoConfirm, true)
    assert.match(base.taskPrompt ?? '', /无人值守/)
    assert.equal(base.taskPrompt, DEFAULT_MAIL_TASK_PROMPT)
    const custom = normalizeMailSettings({ taskPrompt: '  我的邮件提示词  ', autoConfirm: false })
    assert.equal(custom.taskPrompt, '我的邮件提示词')
    assert.equal(custom.autoConfirm, false)
    assert.equal(normalizeMailSettings({ taskPrompt: '   ' }).taskPrompt, DEFAULT_MAIL_TASK_PROMPT)
  })

  it('白名单大小写不敏感；结果摘要不含逐步 tool 日志', () => {
    assert.equal(isWhitelisted('Owner@example.com', ['owner@example.com']), true)
    assert.equal(isWhitelisted('asd@163.com', ['owner@example.com']), false)
    const { allowed, skipped } = filterWhitelistedMails(
      [
        { id: '1', from: 'asd@163.com', subject: 'a', body: 'x' },
        { id: '2', from: 'ass@163.com', subject: 'b', body: 'y' },
        { id: '3', from: 'owner@example.com', subject: 'c', body: 'z' },
      ],
      ['owner@example.com'],
    )
    assert.deepEqual(
      allowed.map((item) => item.id),
      ['3'],
    )
    assert.equal(skipped.length, 2)
    const summary = buildResultSummary({
      ok: true,
      subject: '做周报',
      summary: '已生成周报',
      artifactPaths: ['/tmp/report.md'],
    })
    assert.match(summary, /执行成功/)
    assert.doesNotMatch(summary, /workbench_fs_|tool_call|stdout/)
    assert.equal(cronForPollMinutes(10), '*/10 * * * *')
  })

  it('启用后写入设置并创建群主拉信任务；processInbox 白名单+去重', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-mail-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const executed: string[] = []
    const mail = createMailInstructionService(database, {
      execute: async (item) => {
        executed.push(item.id)
        return { ok: true, summary: `完成：${item.subject}`, artifactPaths: ['/tmp/out.md'] }
      },
    })

    const conf = await mail.updateSettings({
      enabled: true,
      whitelist: ['owner@example.com'],
      pollIntervalMinutes: 10,
      imap: { host: 'imap.example.com', port: 993, tls: true, username: 'bot@example.com' },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, username: 'bot@example.com' },
    })
    assert.equal(conf.enabled, true)
    assert.deepEqual(conf.whitelist, ['owner@example.com'])
    assert.equal((await getAppSettings(database)).mailInstructions.enabled, true)

    const task = (await database.read()).stores.tasks.find((item) => item.id === MAIL_POLL_TASK_ID)
    assert.ok(task)
    assert.equal(task?.schedule, 'cron')
    assert.equal(task?.cron, '*/10 * * * *')
    assert.equal(task?.enabled, true)
    assert.equal(task?.friendId, 'role-owner')
    assert.equal(task?.kind, 'system_mail_poll')

    const inbox = [
      { id: 'm1', from: 'asd@163.com', subject: '忽略我', body: 'no' },
      { id: 'm2', from: 'owner@example.com', subject: '任务A', body: 'do A' },
      { id: 'm3', from: 'OWNER@example.com', subject: '任务B', body: 'do B' },
    ]
    const first = await mail.processInbox(inbox)
    assert.equal(first.filter((item) => item.status === 'executed').length, 2)
    assert.equal(first.filter((item) => item.status === 'skipped').length, 1)
    assert.deepEqual(executed.sort(), ['m2', 'm3'])
    for (const row of first.filter((item) => item.status === 'executed')) {
      assert.ok(row.resultSummary)
      assert.doesNotMatch(row.resultSummary!, /逐步|tool_call|workbench_/)
    }

    executed.length = 0
    const second = await mail.processInbox(inbox)
    assert.equal(executed.length, 0)
    assert.ok(second.every((item) => item.status === 'skipped'))
    assert.ok(second.every((item) => item.reason?.includes('已处理')))

    // ensure 幂等
    await ensureOwnerMailPollTask(database)
    assert.equal((await database.read()).stores.tasks.filter((item) => item.id === MAIL_POLL_TASK_ID).length, 1)

    await updateAppSettings(database, { mailInstructions: { enabled: false } })
    await assert.rejects(() => mail.processInbox(inbox), /未启用/)
  })
})
