/**
 * p1.2 / p1.3.1 邮箱工作指令：
 * 应用侧 IMAP 拉信 → 白名单/去重 → 写入绑定好友会话并触发编排 → SMTP 回结果摘要。
 * 模型不连邮箱；MAIL_POLL 任务 kind=system_mail_poll，runner 短路走本模块。
 * p1.4.1：defaultFetch/Send 改为真协议（mail-transport + 保险库密码）。
 */

import type {
  AutomationTask,
  Conversation,
  MailInstructionSettings,
  ProcessedMailRecord,
} from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import type { Repos } from '../storage/repos/index.ts'
import {
  DEFAULT_MAIL_POLL_MINUTES,
  OWNER_FRIEND_ID,
  normalizeMailSettings,
} from '../storage/schema.ts'
import { createConversation } from './conversations.ts'
import { getAppSettings, updateAppSettings } from './settings.ts'
import { AppError } from './errors.ts'
import {
  MAIL_POLL_TASK_ID,
  MAIL_POLL_TASK_KIND,
  MAIL_POLL_TASK_NAME,
  MAIL_SYSTEM_DESCRIPTION,
} from '../domain/mail-constants.ts'

// 常量本体在 domain/mail-constants.ts（浏览器安全）；这里再导出，保持既有服务端 import 不变。
export {
  MAIL_POLL_TASK_ID,
  MAIL_POLL_TASK_KIND,
  MAIL_POLL_TASK_NAME,
  MAIL_SYSTEM_DESCRIPTION,
} from '../domain/mail-constants.ts'

export type MockMail = {
  id: string
  from: string
  subject: string
  body: string
  receivedAt?: number
}

export type MailProcessResult = {
  mailId: string
  from: string
  subject: string
  status: ProcessedMailRecord['status']
  reason?: string
  resultSummary?: string
  /** 供 SMTP 回信；逐步 tool 日志不得进入此字段。 */
  resultEmailBody?: string
}

export type ExecuteMailInstruction = (mail: MockMail, signal?: AbortSignal) => Promise<{
  ok: boolean
  summary: string
  artifactPaths?: string[]
  error?: string
}>

export type FetchInboxFn = (
  conf: MailInstructionSettings,
  signal?: AbortSignal,
) => Promise<MockMail[]>

export type SendSmtpFn = (input: {
  to: string
  subject: string
  body: string
  conf: MailInstructionSettings
  signal?: AbortSignal
}) => Promise<void>

export type DispatchMailInstructionFn = (input: {
  mail: MockMail
  task: AutomationTask
  conversationId: string
  instructionText: string
  signal?: AbortSignal
}) => Promise<{
  ok: boolean
  summary: string
  artifactPaths?: string[]
  error?: string
}>

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase()
}

export function isWhitelisted(from: string, whitelist: string[]): boolean {
  const target = normalizeEmail(from)
  return whitelist.some((item) => normalizeEmail(item) === target)
}

export function filterWhitelistedMails(
  mails: MockMail[],
  whitelist: string[],
): { allowed: MockMail[]; skipped: MockMail[] } {
  const allowed: MockMail[] = []
  const skipped: MockMail[] = []
  for (const mail of mails) {
    if (isWhitelisted(mail.from, whitelist)) allowed.push(mail)
    else skipped.push(mail)
  }
  return { allowed, skipped }
}

/** 结果邮件：只报结果摘要，禁止逐步 tool 流水。 */
export function buildResultSummary(input: {
  ok: boolean
  subject: string
  summary: string
  artifactPaths?: string[]
  error?: string
}): string {
  const lines = [
    input.ok ? '工作指令执行成功。' : '工作指令执行失败。',
    `主题：${input.subject}`,
    `摘要：${input.summary.trim() || (input.ok ? '已完成' : input.error || '失败')}`,
  ]
  if (input.artifactPaths?.length) {
    lines.push(`产物：${input.artifactPaths.join('；')}`)
  }
  if (!input.ok && input.error) lines.push(`错误：${input.error}`)
  return lines.join('\n')
}

export function cronForPollMinutes(minutes: number): string {
  const n = Math.max(1, Math.round(minutes))
  if (n < 60) return `*/${n} * * * *`
  const hours = Math.floor(n / 60)
  return `0 */${hours} * * *`
}

export function isMailPollTask(task: Pick<AutomationTask, 'id' | 'kind'>): boolean {
  return task.id === MAIL_POLL_TASK_ID || task.kind === MAIL_POLL_TASK_KIND
}

/** 写入会话的工作指令正文（含发件人/主题元信息）。 */
export function buildWorkInstructionText(mail: MockMail): string {
  const body = mail.body.trim() || '（正文为空）'
  return ['【邮件工作指令】', `发件人：${mail.from}`, `主题：${mail.subject}`, '', body].join('\n')
}

/** 未启用 / 缺凭证：人话失败，调用方不得调模型。 */
export function assertMailReady(conf: MailInstructionSettings): void {
  if (!conf.enabled) {
    throw new AppError(400, '邮箱工作指令未启用。请先在设置里打开并配置白名单与 IMAP/SMTP。')
  }
  if (conf.whitelist.length === 0) {
    throw new AppError(400, '请先配置工作指令发件人白名单。')
  }
  if (!conf.imap.host.trim() || !conf.imap.username.trim()) {
    throw new AppError(400, 'IMAP 未配置完整（需要主机与用户名）。')
  }
  if (!conf.smtp.host.trim() || !conf.smtp.username.trim()) {
    throw new AppError(400, 'SMTP 未配置完整（需要主机与用户名）。')
  }
  if (!conf.imap.vaultEntryId) {
    throw new AppError(400, '缺少 IMAP 密码凭证。请在设置里关联保险库条目。')
  }
  if (!conf.smtp.vaultEntryId) {
    throw new AppError(400, '缺少 SMTP 密码凭证。请在设置里关联保险库条目。')
  }
}

/** 应用级短摘要：拉取 N、执行 M、跳过 K、失败原因。 */
export function summarizeMailPollRun(input: {
  fetched: number
  results: MailProcessResult[]
}): string {
  const executed = input.results.filter((item) => item.status === 'executed').length
  const skipped = input.results.filter((item) => item.status === 'skipped').length
  const failed = input.results.filter((item) => item.status === 'failed')
  const lines = [
    `拉取 ${input.fetched} 封，执行 ${executed}，跳过 ${skipped}，失败 ${failed.length}。`,
  ]
  for (const item of failed.slice(0, 5)) {
    lines.push(`失败「${item.subject}」：${item.reason || item.resultSummary || '未知原因'}`)
  }
  const skipReasons = input.results
    .filter((item) => item.status === 'skipped' && item.reason)
    .slice(0, 3)
  for (const item of skipReasons) {
    lines.push(`跳过「${item.subject}」：${item.reason}`)
  }
  const text = lines.join('\n')
  if (/没有邮箱|邮箱系统操作工具|邮箱工具/i.test(text)) {
    throw new AppError(500, '内部错误：拉信摘要不应出现模型推脱文案。')
  }
  return text
}

export type MailInstructionService = ReturnType<typeof createMailInstructionService>

export function createMailInstructionService(
  database: WorkbenchDatabase,
  options: { execute?: ExecuteMailInstruction } = {},
) {
  async function settings(): Promise<MailInstructionSettings> {
    return (await getAppSettings(database)).mailInstructions
  }

  return {
    getSettings: settings,

    async updateSettings(patch: Partial<MailInstructionSettings>): Promise<MailInstructionSettings> {
      const next = await updateAppSettings(database, { mailInstructions: patch })
      if (next.mailInstructions.enabled) {
        await ensureOwnerMailPollTask(database, next.mailInstructions)
      }
      return next.mailInstructions
    },

    async listProcessed(): Promise<ProcessedMailRecord[]> {
      return (await database.read()).stores.processedMails.slice().sort((a, b) => b.processedAt - a.processedAt)
    },

    /**
     * mock / 真源通用：白名单 → 去重 → 执行 → 记 processed → 结果摘要。
     * executeOverride 优先于构造时注入的 execute。
     */
    async processInbox(
      mails: MockMail[],
      signal?: AbortSignal,
      executeOverride?: ExecuteMailInstruction,
    ): Promise<MailProcessResult[]> {
      const conf = await settings()
      if (!conf.enabled) {
        throw new AppError(400, '邮箱工作指令未启用。请先在设置里打开并配置白名单。')
      }
      if (conf.whitelist.length === 0) {
        throw new AppError(400, '请先配置工作指令发件人白名单。')
      }
      const execute = executeOverride ?? options.execute
      const existing = new Set((await database.read()).stores.processedMails.map((item) => item.id))
      const { allowed, skipped } = filterWhitelistedMails(mails, conf.whitelist)
      const results: MailProcessResult[] = []
      const toStore: ProcessedMailRecord[] = []

      for (const mail of skipped) {
        if (existing.has(mail.id)) {
          results.push({
            mailId: mail.id,
            from: mail.from,
            subject: mail.subject,
            status: 'skipped',
            reason: '已处理过，跳过',
          })
          continue
        }
        const row: ProcessedMailRecord = {
          id: mail.id,
          from: mail.from,
          subject: mail.subject,
          status: 'skipped',
          reason: '发件人不在白名单',
          processedAt: Date.now(),
        }
        toStore.push(row)
        existing.add(mail.id)
        results.push({
          mailId: mail.id,
          from: mail.from,
          subject: mail.subject,
          status: 'skipped',
          reason: row.reason,
        })
        log('info', 'mail', '跳过非白名单邮件', { id: mail.id, from: mail.from })
      }

      for (const mail of allowed) {
        if (existing.has(mail.id)) {
          results.push({
            mailId: mail.id,
            from: mail.from,
            subject: mail.subject,
            status: 'skipped',
            reason: '已处理过，跳过',
          })
          continue
        }
        if (signal?.aborted) throw new AppError(400, '拉信任务已取消。')
        try {
          const executed = execute
            ? await execute(mail, signal)
            : { ok: true, summary: `已接收指令：${mail.subject}` }
          const resultSummary = buildResultSummary({
            ok: executed.ok,
            subject: mail.subject,
            summary: executed.summary,
            artifactPaths: executed.artifactPaths,
            error: executed.error,
          })
          const status: ProcessedMailRecord['status'] = executed.ok ? 'executed' : 'failed'
          const row: ProcessedMailRecord = {
            id: mail.id,
            from: mail.from,
            subject: mail.subject,
            status,
            resultSummary,
            processedAt: Date.now(),
            ...(executed.ok ? {} : { reason: executed.error || '执行失败' }),
          }
          toStore.push(row)
          existing.add(mail.id)
          results.push({
            mailId: mail.id,
            from: mail.from,
            subject: mail.subject,
            status,
            reason: row.reason,
            resultSummary,
            resultEmailBody: resultSummary,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : '执行失败'
          const resultSummary = buildResultSummary({
            ok: false,
            subject: mail.subject,
            summary: '执行异常',
            error: message,
          })
          const row: ProcessedMailRecord = {
            id: mail.id,
            from: mail.from,
            subject: mail.subject,
            status: 'failed',
            reason: message,
            resultSummary,
            processedAt: Date.now(),
          }
          toStore.push(row)
          existing.add(mail.id)
          results.push({
            mailId: mail.id,
            from: mail.from,
            subject: mail.subject,
            status: 'failed',
            reason: message,
            resultSummary,
            resultEmailBody: resultSummary,
          })
        }
      }

      if (toStore.length > 0) {
        await database.update((document) => {
          document.stores.processedMails.push(...toStore)
        })
      }
      return results
    },
  }
}

/** 该好友最近一条私聊；没有则按好友名字新建。 */
export async function resolveFriendDirectConversation(repos: Repos, friendId: string): Promise<Conversation> {
  const conversations = await repos.conversations.list()
  const direct = conversations
    .filter(
      (item) =>
        item.kind === 'direct' &&
        item.friendIds.length === 1 &&
        item.friendIds[0] === friendId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (direct) return direct
  const friends = await repos.friends.list()
  const friend = friends.find((item) => item.id === friendId)
  return createConversation(repos, friend?.name || '邮件工作指令', {
    kind: 'direct',
    friendIds: [friendId],
  })
}

/** 解析绑定好友目标会话：指定优先；否则该好友最近私聊；没有则新建。 */
export async function resolveMailTargetConversation(
  repos: Repos,
  task: AutomationTask,
): Promise<Conversation> {
  if (task.targetConversationId?.trim()) {
    const found = await repos.conversations.get(task.targetConversationId.trim())
    if (found) return found
  }
  return resolveFriendDirectConversation(repos, task.friendId)
}

export type MailPollPipelineOptions = {
  database: WorkbenchDatabase
  repos: Repos
  task: AutomationTask
  signal?: AbortSignal
  fetchInbox: FetchInboxFn
  sendSmtp: SendSmtpFn
  dispatch: DispatchMailInstructionFn
  /** 测试用：覆盖 settings 读取前的断言。 */
  mailService?: MailInstructionService
}

/**
 * MAIL_POLL runner 主路径：不进普通 chat prompt。
 * 返回写入任务历史的应用级短摘要。
 */
export async function runMailPollPipeline(options: MailPollPipelineOptions): Promise<string> {
  const conf = (await getAppSettings(options.database)).mailInstructions
  assertMailReady(conf)

  const conversation = await resolveMailTargetConversation(options.repos, options.task)
  const mailService = options.mailService ?? createMailInstructionService(options.database)
  const mails = await options.fetchInbox(conf, options.signal)
  const smtpCalls: Array<{ to: string; subject: string; body: string }> = []

  const results = await mailService.processInbox(mails, options.signal, async (mail, signal) => {
    const instructionText = buildWorkInstructionText(mail)
    const dispatched = await options.dispatch({
      mail,
      task: options.task,
      conversationId: conversation.id,
      instructionText,
      signal,
    })
    const resultSummary = buildResultSummary({
      ok: dispatched.ok,
      subject: mail.subject,
      summary: dispatched.summary,
      artifactPaths: dispatched.artifactPaths,
      error: dispatched.error,
    })
    try {
      await options.sendSmtp({
        to: mail.from,
        subject: `Re: ${mail.subject}`,
        body: resultSummary,
        conf,
        signal,
      })
      smtpCalls.push({ to: mail.from, subject: `Re: ${mail.subject}`, body: resultSummary })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SMTP 发送失败'
      log('warn', 'mail', 'SMTP 回信失败', { mailId: mail.id, error: message })
      return {
        ok: false,
        summary: dispatched.summary,
        artifactPaths: dispatched.artifactPaths,
        error: `会话侧：${dispatched.ok ? '已下发' : dispatched.error || '失败'}；SMTP：${message}`,
      }
    }
    return dispatched
  })

  const summary = summarizeMailPollRun({ fetched: mails.length, results })
  log('info', 'mail', '拉信流水线完成', {
    fetched: mails.length,
    smtp: smtpCalls.length,
    conversationId: conversation.id,
  })
  return summary
}

/** p1.4.1：真协议默认实现见 mail-transport；此处再导出便于旧 import。 */
export {
  createMailTransport,
  defaultFetchInbox,
  defaultSendSmtp,
  humanizeMailError,
  htmlToPlainText,
  truncateMailBody,
  extractMailBody,
  resolveVaultPassword,
  MAIL_BODY_MAX_CHARS,
} from './mail-transport.ts'
export type {
  MailTransport,
  MailTransportOptions,
  ImapFetchAdapter,
  SmtpSendAdapter,
  RevealMailSecretFn,
} from './mail-transport.ts'

/** 启用邮箱时为群主确保默认定时拉信任务（kind=system_mail_poll）。 */
export async function ensureOwnerMailPollTask(
  database: WorkbenchDatabase,
  conf?: MailInstructionSettings,
): Promise<AutomationTask> {
  const mail = conf ?? normalizeMailSettings((await getAppSettings(database)).mailInstructions)
  const minutes = mail.pollIntervalMinutes || DEFAULT_MAIL_POLL_MINUTES
  const cron = cronForPollMinutes(minutes)
  const now = Date.now()
  let saved: AutomationTask | undefined
  await database.update((document) => {
    const owner =
      document.stores.friends.find((item) => item.isOwnerTemplate) ??
      document.stores.friends.find((item) => item.id === OWNER_FRIEND_ID)
    if (!owner) throw new AppError(400, '找不到群主好友，无法创建拉信任务。')
    const existing = document.stores.tasks.find((item) => item.id === MAIL_POLL_TASK_ID)
    const task: AutomationTask = {
      id: MAIL_POLL_TASK_ID,
      name: MAIL_POLL_TASK_NAME,
      kind: MAIL_POLL_TASK_KIND,
      friendId: existing?.friendId ?? owner.id,
      prompt: MAIL_SYSTEM_DESCRIPTION,
      schedule: 'cron',
      cron,
      scope: 'global',
      enabled: mail.enabled,
      lastStatus: existing?.lastStatus ?? 'none',
      history: existing?.history ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.targetConversationId ? { targetConversationId: existing.targetConversationId } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    }
    const index = document.stores.tasks.findIndex((item) => item.id === MAIL_POLL_TASK_ID)
    if (index === -1) document.stores.tasks.push(task)
    else document.stores.tasks[index] = task
    saved = task
  })
  log('info', 'mail', '已确保群主拉信定时任务', { id: MAIL_POLL_TASK_ID, cron, kind: MAIL_POLL_TASK_KIND })
  return saved as AutomationTask
}
