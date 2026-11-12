/**
 * 从邮件正文里认出点名的好友或群，并把点名从任务里拿掉。
 * 例如「帮我看看字段，停车场业务的」→ 好友「停车场业务开发」，任务只留「帮我看看字段」。
 * 对不上、或两个目标一样像时，不改道，仍交给拉信任务绑定的会话。
 */

export type MailRouteFriend = {
  id: string
  name: string
  isOwnerTemplate?: boolean
}

export type MailRouteGroup = {
  id: string
  title: string
  archived?: boolean
  updatedAt: number
  lineageId?: string
}

export type MailRoute = {
  kind: 'friend' | 'group'
  /** 好友 id，或群会话 id。 */
  id: string
  name: string
  /** 去掉点名后的任务正文。 */
  instruction: string
}

type Candidate = {
  kind: 'friend' | 'group'
  id: string
  name: string
  updatedAt: number
}

type Frame = {
  text: string
  /** end：必须贴在全文末尾；start：必须贴在开头。 */
  place: 'any' | 'end' | 'start'
  strip: boolean
  /** 点名自带的引导（逗号、@、交给），不再要求前一个字是分隔符。 */
  lead: boolean
  bonus: number
}

const AFTER_BOUNDARY = /^(?:$|[\s，,。；;：:、的里中上])/

/**
 * 正文优先。正文没点名时再看主题；主题点名不改正文。
 * 群主自己的名字不当成转交目标。
 */
export function resolveMailRoute(input: {
  body: string
  subject?: string
  friends: MailRouteFriend[]
  groups: MailRouteGroup[]
}): MailRoute | null {
  const candidates = listCandidates(input.friends, input.groups)
  if (candidates.length === 0) return null
  const body = input.body ?? ''
  const fromBody = matchInText(body, candidates)
  if (fromBody) {
    const instruction = (fromBody.strip ? removeSpan(body, fromBody.start, fromBody.end) : body).trim()
    if (!instruction) return null
    return { kind: fromBody.kind, id: fromBody.id, name: fromBody.name, instruction }
  }
  const subject = input.subject?.trim() ?? ''
  const task = body.trim()
  if (!subject || !task) return null
  const fromSubject = matchInText(subject, candidates)
  if (!fromSubject) return null
  return { kind: fromSubject.kind, id: fromSubject.id, name: fromSubject.name, instruction: task }
}

function listCandidates(friends: MailRouteFriend[], groups: MailRouteGroup[]): Candidate[] {
  const people = friends
    .filter((friend) => !friend.isOwnerTemplate && friend.name.trim())
    .map((friend) => ({
      kind: 'friend' as const,
      id: friend.id,
      name: friend.name.trim(),
      updatedAt: 0,
    }))
  const visible = visibleGroups(groups).map((group) => ({
    kind: 'group' as const,
    id: group.id,
    name: group.title.trim(),
    updatedAt: group.updatedAt,
  }))
  return [...people, ...visible].filter((item) => item.name.length >= 2)
}

/** 同一条群的多段对话只留最新一段；已归档的不接邮件。 */
function visibleGroups(groups: MailRouteGroup[]): MailRouteGroup[] {
  const latest = new Map<string, MailRouteGroup>()
  for (const group of groups) {
    const title = group.title.trim()
    if (!title) continue
    const key = group.lineageId || group.id
    const prev = latest.get(key)
    if (!prev || group.updatedAt >= prev.updatedAt) latest.set(key, group)
  }
  return [...latest.values()].filter((group) => !group.archived && group.title.trim())
}

type Hit = {
  kind: 'friend' | 'group'
  id: string
  name: string
  score: number
  start: number
  end: number
  strip: boolean
}

function matchInText(text: string, candidates: Candidate[]): Hit | null {
  const hits: Hit[] = []
  for (const candidate of candidates) {
    const hit = bestFrame(text, candidate)
    if (hit) hits.push(hit)
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => b.score - a.score || b.name.length - a.name.length)
  const top = hits[0]
  if (!top) return null
  if (hits.some((item) => item.id !== top.id && item.score === top.score)) return null
  return top
}

function bestFrame(text: string, candidate: Candidate): Hit | null {
  let best: Hit | null = null
  const consider = (label: string, exact: boolean, frames: Frame[]) => {
    for (const frame of frames) {
      const found = locate(text, frame)
      if (!found) continue
      const score = (exact ? 1000 : 800) + label.length + frame.bonus
      if (!best || score > best.score) {
        best = {
          kind: candidate.kind,
          id: candidate.id,
          name: candidate.name,
          score,
          start: found.start,
          end: found.end,
          strip: frame.strip,
        }
      }
    }
  }
  for (let length = candidate.name.length; length >= 2; length -= 1) {
    const label = candidate.name.slice(0, length)
    const exact = length === candidate.name.length
    consider(label, exact, framesFor(label, exact, candidate.kind))
  }
  if (candidate.kind === 'group') {
    // 群名出现在句子中间也算点名，任务正文保留群名，方便群里接着做。
    consider(candidate.name, true, [{ text: candidate.name, place: 'any', strip: false, lead: true, bonus: 0 }])
    if (candidate.name.endsWith('群') && candidate.name.length > 3) {
      const bare = candidate.name.slice(0, -1)
      consider(bare, false, [
        ...framesFor(bare, false, 'group'),
        { text: `${bare}群`, place: 'any', strip: false, lead: true, bonus: 40 },
      ])
    }
  }
  return best
}

function framesFor(label: string, exact: boolean, kind: 'friend' | 'group'): Frame[] {
  // 「，某某的」更像在点好友，略高于同字数的群名简称。
  const de = !exact && kind === 'friend' ? 80 : 0
  return [
    { text: `@${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `@ ${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `＠${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `交给${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `交给 ${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `发给${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `发给 ${label}`, place: 'any', strip: true, lead: true, bonus: 0 },
    { text: `，${label}的`, place: 'end', strip: true, lead: true, bonus: de },
    { text: `,${label}的`, place: 'end', strip: true, lead: true, bonus: de },
    { text: `，${label}`, place: 'end', strip: true, lead: true, bonus: 0 },
    { text: `,${label}`, place: 'end', strip: true, lead: true, bonus: 0 },
    { text: `${label}的`, place: 'end', strip: true, lead: false, bonus: de },
    { text: label, place: 'end', strip: true, lead: false, bonus: 0 },
    { text: `${label}：`, place: 'start', strip: true, lead: false, bonus: 0 },
    { text: `${label}:`, place: 'start', strip: true, lead: false, bonus: 0 },
  ]
}

function locate(text: string, frame: Frame): { start: number; end: number } | null {
  let from = 0
  while (from <= text.length) {
    const start = text.indexOf(frame.text, from)
    if (start < 0) return null
    const end = start + frame.text.length
    const prev = start > 0 ? text[start - 1] ?? '' : ''
    const emailAt = (frame.text.startsWith('@') || frame.text.startsWith('＠')) && /[A-Za-z0-9._%+-]/.test(prev)
    const leadOk = frame.lead || start === 0 || /[\s，,。；;：:、]/.test(prev)
    const atEnd = text.slice(end).trim() === ''
    const atStart = text.slice(0, start).trim() === ''
    const bounded = AFTER_BOUNDARY.test(text.slice(end))
    const placeOk =
      (frame.place === 'end' && atEnd) ||
      (frame.place === 'start' && atStart) ||
      (frame.place === 'any' && bounded)
    if (!emailAt && leadOk && placeOk) return { start, end }
    from = start + 1
  }
  return null
}

function removeSpan(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${text.slice(end)}`
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，,。\s]+|[，,。\s]+$/g, '')
    .trim()
}
