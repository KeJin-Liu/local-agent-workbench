/**
 * 回合结束后写入会话摘要。取消、失败、还在等待的 run 一律不写。
 * p1.1.3：摘要写成事件列表（请求 / 决策 / 确认卡 / 落库 / 未决），
 * 禁止粘贴整段气泡；单会话硬顶；增量改写事件。
 */

import type { Message, Proposal, Run, Summary } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { AppError } from '../app/errors.ts'

/** 单会话摘要汉字硬顶（落在方案 800–1200 内）。 */
export const SUMMARY_HARD_CAP_CHARS = 1000

const FOOTER = '后续提问会带上此摘要，不必重复背景。'
const HEADER = '事件'

export type SummaryEvent = {
  /** 稳定键，用于增量改写（同键覆盖）。 */
  key: string
  text: string
}

export type SummarizeOptions = {
  proposals?: Proposal[]
  /** 上一版摘要正文；增量时解析旧事件再合并。 */
  previousContent?: string
  hardCap?: number
}

/** 只有正常走完的回合可以进入记忆。 */
export function shouldPersistMemory(run: Run): boolean {
  return run.status === 'done'
}

/** 按码点计长度（汉字 / 拉丁均 1）。 */
export function countSummaryChars(text: string): number {
  return [...text].length
}

function compress(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  if ([...flat].length <= max) return flat
  return `${[...flat].slice(0, Math.max(0, max - 1)).join('')}…`
}

function kindLabel(kind: Proposal['kind']): string {
  if (kind === 'friend') return '好友'
  if (kind === 'skill') return '技能'
  if (kind === 'mcp') return 'MCP'
  return '任务'
}

function personaBits(proposal: Proposal): string {
  const draft = proposal.draft ?? {}
  const parts: string[] = []
  const description = typeof draft.description === 'string' ? draft.description.trim() : ''
  const systemPrompt = typeof draft.systemPrompt === 'string' ? draft.systemPrompt.trim() : ''
  const summary = proposal.summary?.trim() && proposal.summary !== proposal.name ? proposal.summary.trim() : ''
  if (description) parts.push(compress(description, 40))
  else if (summary) parts.push(compress(summary, 40))
  if (systemPrompt) parts.push(compress(systemPrompt, 36))
  return parts.filter(Boolean).join('、')
}

function proposalEvents(proposals: Proposal[]): SummaryEvent[] {
  return proposals.map((proposal) => {
    const shortId = proposal.id.slice(0, 8)
    const label = kindLabel(proposal.kind)
    if (proposal.status === 'pending') {
      return {
        key: `proposal:${proposal.id}`,
        text: `用户请求创建「${proposal.name}」${label}→ 已出确认卡 \`${shortId}\`，待用户确认才落库`,
      }
    }
    if (proposal.status === 'confirmed') {
      const bits = personaBits(proposal)
      return {
        key: `proposal:${proposal.id}`,
        text: `（确认后）${label}「${proposal.name}」已保存${bits ? `；要点：${bits}` : ''}`,
      }
    }
    return {
      key: `proposal:${proposal.id}`,
      text: `${label}「${proposal.name}」确认卡已取消，未落库`,
    }
  })
}

/** 从助手短文里抽未决问题；绝不贴长文。 */
function openQuestionFromAssistant(content: string, messageId: string): SummaryEvent | null {
  const flat = content.trim().replace(/\s+/g, ' ')
  if (!flat) return null
  // 仅在较短回复里找未决；长文直接跳过，避免原文泄漏进摘要
  if ([...flat].length > 220) {
    const q = flat.match(/[^。！？\n]{4,40}[？?]/)
    if (!q) return null
    return { key: `open:${messageId}`, text: `未决：${compress(q[0], 48)}` }
  }
  if (/[？?]/.test(flat) || /待选|未决|可选|还是/.test(flat)) {
    return { key: `open:${messageId}`, text: `未决：${compress(flat, 72)}` }
  }
  return null
}

function userRequestEvent(message: Message): SummaryEvent {
  return {
    key: `user:${message.id}`,
    text: `用户请求：${compress(message.content, 72)}`,
  }
}

/** 解析旧摘要里的 `- …` 事件行。 */
export function parseSummaryEvents(content: string): SummaryEvent[] {
  const events: SummaryEvent[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const text = trimmed.slice(2).trim()
    if (!text || text === FOOTER) continue
    const proposalMatch = text.match(/确认卡\s*`([0-9a-f-]{8})/i) || text.match(/确认卡\s*([0-9a-f-]{8})/i)
    const savedMatch = text.match(/「([^」]+)」已保存/)
    const cancelMatch = text.match(/「([^」]+)」确认卡已取消/)
    let key = `legacy:${events.length}:${compress(text, 24)}`
    if (proposalMatch) key = `proposal-short:${proposalMatch[1]}`
    else if (savedMatch) key = `saved:${savedMatch[1]}`
    else if (cancelMatch) key = `cancel:${cancelMatch[1]}`
    else if (text.startsWith('用户请求：') || text.startsWith('用户请求创建')) key = `req:${compress(text, 32)}`
    else if (text.startsWith('未决：')) key = `open:${compress(text, 32)}`
    events.push({ key, text })
  }
  return events
}

function mergeEvents(previous: SummaryEvent[], next: SummaryEvent[]): SummaryEvent[] {
  const map = new Map<string, SummaryEvent>()
  for (const event of previous) map.set(event.key, event)
  for (const event of next) {
    // 提案短 id 与完整 proposal:uuid 对齐：同名覆盖
    if (event.key.startsWith('proposal:')) {
      const short = event.key.slice('proposal:'.length, 'proposal:'.length + 8)
      for (const existing of [...map.keys()]) {
        if (existing === `proposal-short:${short}` || existing.startsWith(`proposal:${short}`)) {
          map.delete(existing)
        }
      }
    }
    map.set(event.key, event)
  }
  return [...map.values()]
}

function renderEvents(events: SummaryEvent[]): string {
  if (events.length === 0) return ''
  return [HEADER, ...events.map((event) => `- ${event.text}`), FOOTER].join('\n')
}

function coarsenPair(a: SummaryEvent, b: SummaryEvent): SummaryEvent {
  const left = compress(a.text.replace(/^用户请求：/, '').replace(/^未决：/, ''), 28)
  const right = compress(b.text.replace(/^用户请求：/, '').replace(/^未决：/, ''), 28)
  return {
    key: `merged:${a.key}:${b.key}`,
    text: `（合并）${left}；${right}`,
  }
}

/** 超出硬顶时把更旧事件合并成粗粒度，直到落入上限。 */
export function applySummaryHardCap(events: SummaryEvent[], hardCap = SUMMARY_HARD_CAP_CHARS): SummaryEvent[] {
  let current = events.slice()
  let rendered = renderEvents(current)
  while (current.length > 1 && countSummaryChars(rendered) > hardCap) {
    const merged = coarsenPair(current[0]!, current[1]!)
    current = [merged, ...current.slice(2)]
    rendered = renderEvents(current)
  }
  if (countSummaryChars(rendered) > hardCap && current.length === 1) {
    const budget = Math.max(24, hardCap - countSummaryChars(`${HEADER}\n- \n${FOOTER}`))
    current = [{ key: current[0]!.key, text: compress(current[0]!.text, budget) }]
  }
  return current
}

/**
 * 把会话收成事件摘要。空对话返回空字符串。
 * 不线性拼接全量消息原文；确认卡语义：pending→待确认，confirmed→已保存。
 */
export function summarizeMessages(messages: Message[], options: SummarizeOptions = {}): string {
  const hardCap = options.hardCap ?? SUMMARY_HARD_CAP_CHARS
  const proposals = options.proposals ?? []
  const visible = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => message.status !== 'error' && message.kind !== 'assign' && message.kind !== 'result')
    .filter((message) => message.content.trim().length > 0)

  const fresh: SummaryEvent[] = []
  const proposalEventsList = proposalEvents(proposals)
  fresh.push(...proposalEventsList)

  const proposalNames = new Set(proposals.map((item) => item.name.trim()).filter(Boolean))

  for (const message of visible) {
    if (message.role === 'user') {
      const compact = compress(message.content, 72)
      // 已有同名创建提案时，用户「创建 XXX」请求由确认卡事件覆盖，避免双份原文
      const coveredByProposal = [...proposalNames].some(
        (name) => compact.includes(name) && /创建|新建|加一个|加个/.test(compact),
      )
      if (!coveredByProposal) fresh.push(userRequestEvent(message))
      continue
    }
    const open = openQuestionFromAssistant(message.content, message.id)
    if (open) fresh.push(open)
  }

  const previous = options.previousContent ? parseSummaryEvents(options.previousContent) : []
  // 有新事件时以合并结果为准；全新生成则只用 fresh
  const merged = previous.length > 0 ? mergeEvents(previous, fresh) : fresh
  // 若既无消息可事件化也无提案，保持空
  if (merged.length === 0) return ''

  const capped = applySummaryHardCap(merged, hardCap)
  return renderEvents(capped)
}

/**
 * 成功回合的记忆入口。取消路径不会调用它；即便被误调，cancelled 也会在这里被挡住。
 * 写完后默认注入后续回合。
 */
export async function persistTurnMemory(repos: Repos, run: Run): Promise<void> {
  if (!shouldPersistMemory(run)) {
    log('info', 'memory', '跳过记忆', {
      runId: run.id,
      conversationId: run.conversationId,
      status: run.status,
    })
    return
  }
  const summary = await writeSummary(repos, run.conversationId, 'auto', true)
  if (!summary) {
    log('info', 'memory', '没有可写入的发言', { runId: run.id, conversationId: run.conversationId })
    return
  }
  log('info', 'memory', '摘要已写入并注入', {
    runId: run.id,
    conversationId: run.conversationId,
    summaryId: summary.id,
  })
}

/** 按当前会话重新生成摘要。手动生成默认先不注入，等用户点「保留并注入」。 */
export async function writeSummary(
  repos: Repos,
  conversationId: string,
  source: 'auto' | 'manual',
  injectOnNextTurn: boolean,
): Promise<Summary | null> {
  const conversation = await repos.conversations.get(conversationId)
  if (!conversation) throw new AppError(404, '找不到这个会话')
  const messages = await repos.messages.listByConversation(conversationId)
  const proposals = await repos.proposals.listByConversation(conversationId)
  const latest = await repos.summaries.latest(conversationId)
  // 每轮从消息 + 确认卡全量重建事件（非原文拼接）；硬顶合并旧事件。
  // 提案状态变化（待确认→已保存）由 proposals 权威数据覆盖，无需解析旧正文键。
  const content = summarizeMessages(messages, { proposals })
  if (!content) {
    if (source === 'manual') throw new AppError(400, '还没有可以摘要的对话。')
    return null
  }
  const now = Date.now()
  const covered = [...messages].reverse().find((message) => message.content.trim())
  const summary: Summary = {
    id: latest?.id ?? crypto.randomUUID(),
    conversationId,
    content,
    injectOnNextTurn,
    source,
    createdAt: latest?.createdAt ?? now,
    updatedAt: now,
    ...(covered ? { coversUntilMessageId: covered.id } : {}),
  }
  await repos.summaries.put(summary)
  log('info', 'memory', source === 'auto' ? '自动写入摘要' : '手动生成摘要', {
    conversationId,
    summaryId: summary.id,
    injectOnNextTurn,
    chars: countSummaryChars(content),
  })
  return summary
}

/** 把已有摘要标成注入后续回合。没有摘要时不新建空记录。 */
export async function injectSummary(repos: Repos, conversationId: string): Promise<Summary> {
  const latest = await repos.summaries.latest(conversationId)
  if (!latest) throw new AppError(400, '还没有摘要。先生成，再注入。')
  const summary: Summary = { ...latest, injectOnNextTurn: true, updatedAt: Date.now() }
  await repos.summaries.put(summary)
  log('info', 'memory', '保留并注入摘要', { conversationId, summaryId: summary.id })
  return summary
}
