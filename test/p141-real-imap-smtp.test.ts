import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  MAIL_BODY_MAX_CHARS,
  MAIL_POLL_TASK_ID,
  assertMailReady,
  createMailTransport,
  extractMailBody,
  htmlToPlainText,
  humanizeMailError,
  isMailPollTask,
  resolveVaultPassword,
  runMailPollPipeline,
  summarizeMailPollRun,
  truncateMailBody,
} from '../src/app/mail-instructions.ts'
import { createTaskService } from '../src/app/tasks.ts'
import { createConversation } from '../src/app/conversations.ts'
import { updateAppSettings } from '../src/app/settings.ts'
import { AppError } from '../src/app/errors.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { OWNER_FRIEND_ID } from '../src/storage/schema.ts'
import { ensureOwnerMailPollTask } from '../src/app/mail-instructions.ts'

describe('p1.4.1 真 IMAP/SMTP 传输', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  async function freshDb() {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-p141-'))
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

  it('humanizeMailError：主机 / 凭证 / TLS 人话', () => {
    assert.match(
      humanizeMailError('imap', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
      /找不到主机/,
    )
    assert.match(
      humanizeMailError('smtp', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      /连接被拒绝|不可达/,
    )
    assert.match(
      humanizeMailError('imap', Object.assign(new Error('self signed certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })),
      /TLS|证书/,
    )
    assert.match(
      humanizeMailError('smtp', Object.assign(new Error('Invalid login: 535 Authentication failed'), { responseCode: 535 })),
      /认证失败|密码/,
    )
    assert.match(humanizeMailError('imap', new Error('something odd')), /IMAP 失败/)
  })

  it('正文：优先纯文本；HTML 降级；过大截断', () => {
    assert.equal(extractMailBody({ text: '  hello  ', html: '<b>x</b>' }), 'hello')
    assert.equal(htmlToPlainText('<p>Hi<br>There</p>'), 'Hi\nThere')
    assert.match(extractMailBody({ html: '<div>订单<strong>42</strong></div>' }), /订单\s*42/)
    const big = '字'.repeat(MAIL_BODY_MAX_CHARS + 50)
    const cut = truncateMailBody(big)
    assert.ok(cut.length < big.length)
    assert.match(cut, /正文已截断/)
  })

  it('resolveVaultPassword：password 优先，apiKey 兜底', () => {
    assert.equal(resolveVaultPassword({ password: ' p ', apiKey: 'k' }), 'p')
    assert.equal(resolveVaultPassword({ apiKey: ' key ' }), 'key')
    assert.equal(resolveVaultPassword({}), undefined)
  })

  it('createMailTransport：IMAP 连失败抛人话，不返回空数组冒充成功', async () => {
    const transport = createMailTransport({
      reveal: async () => ({ password: 'secret' }),
      imapFetch: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND bad.host'), { code: 'ENOTFOUND' })
      },
      smtpSend: async () => {},
    })
    await assert.rejects(
      () =>
        transport.fetchInbox({
          enabled: true,
          whitelist: ['a@b.com'],
          pollIntervalMinutes: 10,
          imap: {
            host: 'bad.host',
            port: 993,
            tls: true,
            username: 'u',
            vaultEntryId: 'v',
          },
          smtp: {
            host: 'smtp',
            port: 465,
            tls: true,
            username: 'u',
            vaultEntryId: 'v',
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError)
        assert.match(err.message, /找不到主机/)
        return true
      },
    )
  })

  it('createMailTransport：缺保险库密码人话失败', async () => {
    const transport = createMailTransport({
      reveal: async () => undefined,
      imapFetch: async () => [],
      smtpSend: async () => {},
    })
    await assert.rejects(
      () =>
        transport.fetchInbox({
          enabled: true,
          whitelist: ['a@b.com'],
          pollIntervalMinutes: 10,
          imap: { host: 'h', port: 993, tls: true, username: 'u', vaultEntryId: 'missing' },
          smtp: { host: 'h', port: 465, tls: true, username: 'u', vaultEntryId: 'v' },
        }),
      /没有可用的 IMAP 密码|IMAP 密码凭证/,
    )
  })

  it('createMailTransport：mock 真客户端拉信 + SMTP；dry-run 不调 send', async () => {
    const fetchedCalls: string[] = []
    const sent: Array<{ to: string; subject: string }> = []
    const transport = createMailTransport({
      reveal: async (id) => ({ password: `pw-${id}` }),
      imapFetch: async (input) => {
        fetchedCalls.push(input.password)
        return [
          { id: 'm1', from: 'boss@example.com', subject: '周报', body: '请写周报' },
          { id: 'm2', from: 'spam@x.com', subject: '广告', body: 'buy' },
        ]
      },
      smtpSend: async (input) => {
        sent.push({ to: input.to, subject: input.subject })
      },
    })
    const conf = {
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
    }
    const mails = await transport.fetchInbox(conf)
    assert.equal(mails.length, 2)
    assert.deepEqual(fetchedCalls, ['pw-vault-imap'])

    await transport.sendSmtp({
      to: 'boss@example.com',
      subject: 'Re: 周报',
      body: 'ok',
      conf,
    })
    assert.deepEqual(sent, [{ to: 'boss@example.com', subject: 'Re: 周报' }])

    const dry = createMailTransport({
      reveal: async () => ({ password: 'x' }),
      dryRunSmtp: true,
      smtpSend: async () => {
        throw new Error('should not send')
      },
    })
    await dry.sendSmtp({ to: 'a@b.com', subject: 's', body: 'b', conf })
  })

  it('pipeline：连失败进任务历史为人话，禁止静默拉取 0', async () => {
    const { database, repos } = await freshDb()
    await enableMail(database)
    const transport = createMailTransport({
      reveal: async () => ({ password: 'x' }),
      imapFetch: async () => {
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
      },
      smtpSend: async () => {},
    })
    const tasks = createTaskService(database, async (task, signal) => {
      if (!isMailPollTask(task)) return 'nope'
      return runMailPollPipeline({
        database,
        repos,
        task,
        signal,
        fetchInbox: transport.fetchInbox,
        sendSmtp: transport.sendSmtp,
        dispatch: async () => ({ ok: true, summary: 'should-not-run' }),
      })
    })
    await assert.rejects(() => tasks.run(MAIL_POLL_TASK_ID), /超时|IMAP/)
    const after = (await database.read()).stores.tasks.find((item) => item.id === MAIL_POLL_TASK_ID)!
    assert.equal(after.lastStatus, 'error')
    assert.match(after.lastError || '', /超时|IMAP/)
    assert.doesNotMatch(after.lastError || '', /^拉取 0/)
    assert.match(after.history[0]?.error || '', /超时|IMAP/)
  })

  it('pipeline 回归：白名单 / 去重 / runner 短路；SMTP 经 transport', async () => {
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

    let chatPromptHits = 0
    const smtp: string[] = []
    const transport = createMailTransport({
      reveal: async () => ({ password: 'secret' }),
      imapFetch: async () => [
        { id: 'm-skip', from: 'stranger@example.com', subject: '广告', body: 'buy' },
        { id: 'm-ok', from: 'boss@example.com', subject: '周报', body: '请生成本周周报' },
      ],
      smtpSend: async (input) => {
        smtp.push(input.to)
      },
    })

    const tasks = createTaskService(database, async (current, signal) => {
      if (!isMailPollTask(current)) {
        chatPromptHits += 1
        return `prompt:${current.prompt}`
      }
      return runMailPollPipeline({
        database,
        repos,
        task: current,
        signal,
        fetchInbox: transport.fetchInbox,
        sendSmtp: transport.sendSmtp,
        dispatch: async ({ mail, instructionText }) => {
          assert.match(instructionText, /请生成本周周报/)
          assert.equal(mail.from, 'boss@example.com')
          return { ok: true, summary: '已下发' }
        },
      })
    })

    const after = await tasks.run(MAIL_POLL_TASK_ID)
    assert.equal(after.lastStatus, 'success')
    assert.equal(chatPromptHits, 0)
    assert.deepEqual(smtp, ['boss@example.com'])
    assert.match(after.history[0]?.result || '', /拉取 2/)
    assert.match(after.history[0]?.result || '', /执行 1/)
    assert.match(after.history[0]?.result || '', /跳过 1/)

    // 去重：再跑一遍应跳过已处理
    const again = await tasks.run(MAIL_POLL_TASK_ID)
    assert.equal(again.lastStatus, 'success')
    assert.match(again.history[0]?.result || '', /拉取 2/)
    assert.match(again.history[0]?.result || '', /执行 0/)
    assert.match(again.history[0]?.result || '', /跳过 2/)
    assert.equal(smtp.length, 1)
  })

  it('SMTP 发送失败记入结果，不假装成功', async () => {
    const { database, repos } = await freshDb()
    await enableMail(database)
    const transport = createMailTransport({
      reveal: async () => ({ password: 'x' }),
      imapFetch: async () => [
        { id: 'm1', from: 'boss@example.com', subject: 'T', body: 'do it' },
      ],
      smtpSend: async () => {
        throw Object.assign(new Error('535 Authentication failed'), { responseCode: 535 })
      },
    })
    const summary = await runMailPollPipeline({
      database,
      repos,
      task: await ensureOwnerMailPollTask(database),
      fetchInbox: transport.fetchInbox,
      sendSmtp: transport.sendSmtp,
      dispatch: async () => ({ ok: true, summary: '会话侧完成' }),
    })
    assert.match(summary, /失败 1/)
    assert.match(summary, /SMTP|认证/)
    const processed = (await database.read()).stores.processedMails.find((item) => item.id === 'm1')
    assert.equal(processed?.status, 'failed')
  })

  it('assertMailReady 与摘要回归仍绿', () => {
    assert.throws(
      () =>
        assertMailReady({
          enabled: false,
          whitelist: [],
          pollIntervalMinutes: 10,
          imap: { host: '', port: 993, tls: true, username: '' },
          smtp: { host: '', port: 465, tls: true, username: '' },
        }),
      /未启用/,
    )
    const text = summarizeMailPollRun({
      fetched: 1,
      results: [{ mailId: '1', from: 'a', subject: 's', status: 'executed' }],
    })
    assert.match(text, /拉取 1/)
  })
})
