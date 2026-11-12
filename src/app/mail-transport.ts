/**
 * p1.4.1：真 IMAP 拉信 + SMTP 回信。
 * 密码从保险库 reveal；失败抛人话错误，禁止静默空收件箱冒充成功。
 */
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import type { MailInstructionSettings } from '../domain/types.ts'
import { log } from '../logger.ts'
import { AppError } from './errors.ts'
import type { FetchInboxFn, MockMail, SendSmtpFn } from './mail-instructions.ts'

export const MAIL_BODY_MAX_CHARS = 80_000

export type RevealedMailSecret = {
  apiKey?: string
  password?: string
}

export type RevealMailSecretFn = (id: string) => Promise<RevealedMailSecret | undefined>

/** 可注入的 IMAP 适配器（单测 mock）。 */
export type ImapFetchAdapter = (input: {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  signal?: AbortSignal
}) => Promise<MockMail[]>

/** 可注入的 SMTP 适配器（单测 mock）。 */
export type SmtpSendAdapter = (input: {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  from: string
  to: string
  subject: string
  body: string
  signal?: AbortSignal
}) => Promise<void>

export type MailTransportOptions = {
  reveal: RevealMailSecretFn
  /** 开发用：连配置走真路径但不发信；默认 false（真发）。 */
  dryRunSmtp?: boolean
  imapFetch?: ImapFetchAdapter
  smtpSend?: SmtpSendAdapter
}

export function resolveVaultPassword(secret: RevealedMailSecret | undefined): string | undefined {
  const password = secret?.password?.trim()
  if (password) return password
  const apiKey = secret?.apiKey?.trim()
  if (apiKey) return apiKey
  return undefined
}

/** HTML → 粗纯文本（无 text 部件时降级）。 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function truncateMailBody(text: string, maxChars = MAIL_BODY_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n（正文已截断，原长 ${text.length} 字）`
}

export function extractMailBody(input: { text?: string | null; html?: string | null }): string {
  const plain = (input.text || '').trim()
  if (plain) return truncateMailBody(plain)
  const html = (input.html || '').trim()
  if (html) return truncateMailBody(htmlToPlainText(html))
  return ''
}

export function humanizeMailError(kind: 'imap' | 'smtp', error: unknown): string {
  if (error instanceof AppError) return error.message
  const raw = error instanceof Error ? error.message : String(error ?? '未知错误')
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
  const responseCode =
    error && typeof error === 'object' && 'responseCode' in error
      ? Number((error as { responseCode?: unknown }).responseCode)
      : undefined
  const blob = `${code} ${raw}`.toLowerCase()
  const label = kind === 'imap' ? 'IMAP' : 'SMTP'

  if (/enotfound|getaddrinfo|err_dns|nxdomain/.test(blob)) {
    return `${label} 连不上：找不到主机。请检查主机名是否写对、本机网络是否可用。`
  }
  if (/econnrefused|econnreset|ehostunreach|enetunreach/.test(blob)) {
    return `${label} 连不上：连接被拒绝或主机不可达。请检查端口、防火墙与服务是否开启。`
  }
  if (/etimedout|timeout|timed out/.test(blob)) {
    return `${label} 连不上：连接超时。请检查主机/端口与网络。`
  }
  if (
    /cert|certificate|ssl|tls|self[_ -]?signed|unable to verify|handshake/.test(blob) ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return `${label} 连不上：TLS/证书校验失败。请确认端口与「使用 TLS」是否匹配，或证书是否有效。`
  }
  if (
    /auth|login|credential|invalid credentials|authentication failed|username|password|535|534|application-specific password/.test(
      blob,
    ) ||
    responseCode === 535 ||
    responseCode === 534
  ) {
    return `${label} 认证失败：用户名或密码不对。请到密码库核对邮箱凭证（部分邮箱需应用专用密码）。`
  }
  if (/econn|socket|network|unreachable/.test(blob)) {
    return `${label} 网络异常：${raw}`
  }
  return `${label} 失败：${raw}`
}

async function resolveEndpointPassword(
  reveal: RevealMailSecretFn,
  vaultEntryId: string | undefined,
  kind: 'imap' | 'smtp',
): Promise<string> {
  if (!vaultEntryId?.trim()) {
    throw new AppError(400, kind === 'imap' ? '缺少 IMAP 密码凭证。' : '缺少 SMTP 密码凭证。')
  }
  const secret = await reveal(vaultEntryId.trim())
  const password = resolveVaultPassword(secret)
  if (!password) {
    throw new AppError(
      400,
      kind === 'imap'
        ? '保险库里没有可用的 IMAP 密码。请打开对应条目确认已保存密码。'
        : '保险库里没有可用的 SMTP 密码。请打开对应条目确认已保存密码。',
    )
  }
  return password
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError(400, '拉信任务已取消。')
}

/** 用 imapflow + mailparser 拉收件箱未读。 */
export const realImapFetch: ImapFetchAdapter = async (input) => {
  throwIfAborted(input.signal)
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.username, pass: input.password },
    logger: false,
    emitLogs: false,
  })

  const onAbort = () => {
    try {
      client.close()
    } catch {
      // ignore
    }
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await client.connect()
    throwIfAborted(input.signal)
    const lock = await client.getMailboxLock('INBOX')
    try {
      const mails: MockMail[] = []
      // UNSEEN：未读；去重仍靠 processedMails
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        throwIfAborted(input.signal)
        const uid = msg.uid
        const envelope = msg.envelope
        const fromAddr =
          envelope?.from?.[0]?.address ||
          envelope?.from?.[0]?.name ||
          ''
        const subject = envelope?.subject || '(无主题)'
        const messageId = envelope?.messageId?.trim()
        const id = messageId || `imap-uid-${uid}`
        let body = ''
        if (msg.source) {
          const parsed = await simpleParser(msg.source)
          body = extractMailBody({ text: parsed.text, html: parsed.html ? String(parsed.html) : null })
        }
        mails.push({
          id,
          from: fromAddr,
          subject,
          body,
          ...(envelope?.date
            ? {
                receivedAt:
                  envelope.date instanceof Date
                    ? envelope.date.getTime()
                    : new Date(envelope.date).getTime(),
              }
            : {}),
        })
      }
      return mails
    } finally {
      lock.release()
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    try {
      if (client.usable) await client.logout()
      else await client.close()
    } catch {
      // ignore logout errors
    }
  }
}

/** 用 nodemailer 发结果摘要。 */
export const realSmtpSend: SmtpSendAdapter = async (input) => {
  throwIfAborted(input.signal)
  const transporter = nodemailer.createTransport({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.username, pass: input.password },
  })
  try {
    await transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
    })
  } finally {
    transporter.close()
  }
}

export type MailTransport = {
  fetchInbox: FetchInboxFn
  sendSmtp: SendSmtpFn
}

/**
 * 创建默认真协议传输。fetch/send 失败抛人话 AppError，
 * 调用方不得把异常吞成「拉取 0」。
 */
export function createMailTransport(options: MailTransportOptions): MailTransport {
  const imapFetch = options.imapFetch ?? realImapFetch
  const smtpSend = options.smtpSend ?? realSmtpSend
  const dryRun = Boolean(options.dryRunSmtp)

  const fetchInbox: FetchInboxFn = async (conf, signal) => {
    throwIfAborted(signal)
    const password = await resolveEndpointPassword(options.reveal, conf.imap.vaultEntryId, 'imap')
    try {
      return await imapFetch({
        host: conf.imap.host.trim(),
        port: conf.imap.port,
        secure: conf.imap.tls,
        username: conf.imap.username.trim(),
        password,
        signal,
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      const message = humanizeMailError('imap', error)
      log('warn', 'mail', 'IMAP 拉信失败', { error: message })
      throw new AppError(502, message)
    }
  }

  const sendSmtp: SendSmtpFn = async (input) => {
    throwIfAborted(input.signal)
    if (dryRun) {
      log('info', 'mail', 'SMTP dry-run（未真发）', {
        to: input.to,
        subject: input.subject,
        bytes: input.body.length,
      })
      return
    }
    const password = await resolveEndpointPassword(options.reveal, input.conf.smtp.vaultEntryId, 'smtp')
    const from = input.conf.smtp.username.trim()
    try {
      await smtpSend({
        host: input.conf.smtp.host.trim(),
        port: input.conf.smtp.port,
        secure: input.conf.smtp.tls,
        username: input.conf.smtp.username.trim(),
        password,
        from,
        to: input.to,
        subject: input.subject,
        body: input.body,
        signal: input.signal,
      })
      log('info', 'mail', 'SMTP 已发送结果摘要', {
        to: input.to,
        subject: input.subject,
        bytes: input.body.length,
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      const message = humanizeMailError('smtp', error)
      log('warn', 'mail', 'SMTP 发送失败', { error: message })
      throw new AppError(502, message)
    }
  }

  return { fetchInbox, sendSmtp }
}

/** 兼容旧名：无保险库上下文时不可用；请用 createMailTransport。 */
export const defaultFetchInbox: FetchInboxFn = async () => {
  throw new AppError(500, '内部错误：未注入真 IMAP 传输（createMailTransport）。')
}

export const defaultSendSmtp: SendSmtpFn = async () => {
  throw new AppError(500, '内部错误：未注入真 SMTP 传输（createMailTransport）。')
}

/** 仅供类型收窄 / 测试构造 conf。 */
export type { MailInstructionSettings }
