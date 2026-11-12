/**
 * 群聊 @ 好友：从消息里认出被点名的群友，并把 @ 后面的任务文本拆出来。
 * 服务端用它决定这一回合由谁回；UI 用它提示「直接由 TA 回复」。
 */

import type { Friend } from './types.ts'

export type MentionFriend = Pick<Friend, 'id' | 'name'>

export type MentionMatch<T extends MentionFriend = MentionFriend> = {
  friend: T
  /** 归一化文本里 '@' 的下标 */
  start: number
  /** 名字结束后的下标 */
  end: number
  /** @ 名字之后剩下的任务文本（已去掉前导标点） */
  task: string
}

const PUNCTUATION = /^[\s，,。.：:；;、]+/

/**
 * 找消息里的第一个群友 @。名字按长度降序匹配，避免「@开发」抢走「@代码开发」。
 * 允许全角 ＠、@ 与名字之间夹空格；邮箱那种紧贴字母数字的 @ 不算。
 */
export function findMention<T extends MentionFriend>(
  text: string,
  friends: T[],
  options: { excludeIds?: string[] } = {},
): MentionMatch<T> | null {
  if (!text) return null
  const normalized = text.replace(/＠/g, '@')
  const exclude = new Set(options.excludeIds ?? [])
  const candidates = friends
    .filter((friend) => friend.name.trim() && !exclude.has(friend.id))
    .sort((a, b) => b.name.trim().length - a.name.trim().length)
  if (candidates.length === 0) return null

  for (let at = normalized.indexOf('@'); at >= 0; at = normalized.indexOf('@', at + 1)) {
    const previous = at > 0 ? normalized[at - 1] ?? '' : ''
    if (previous && /[A-Za-z0-9._%+-]/.test(previous)) continue
    let cursor = at + 1
    while (cursor < normalized.length && /\s/.test(normalized[cursor] ?? '')) cursor += 1
    const rest = normalized.slice(cursor)
    const friend = candidates.find((item) => rest.startsWith(item.name.trim()))
    if (!friend) continue
    const end = cursor + friend.name.trim().length
    const task = normalized.slice(end).replace(PUNCTUATION, '').trim()
    return { friend, start: at, end, task }
  }
  return null
}

/**
 * 交办用的 @。同一条回复里常有「已交给 @某人」这种顺口点名，后面才是真正的任务。
 * 仍交给第一个被点到的好友，但任务取这个人各次 @ 里、到下一个 @ 为止最长的那段。
 */
export function handoffMention<T extends MentionFriend>(
  text: string,
  friends: T[],
  options: { excludeIds?: string[] } = {},
): MentionMatch<T> | null {
  const mentions = listMentions(text, friends, options)
  const first = mentions[0]
  if (!first) return null
  const same = mentions.filter((item) => item.friend.id === first.friend.id)
  let best = first
  let bestTask = ''
  for (const mention of same) {
    const next = mentions.find((item) => item.start > mention.end)
    const raw = text.replace(/＠/g, '@').slice(mention.end, next ? next.start : undefined)
    const task = raw.replace(PUNCTUATION, '').trim()
    if (task.length > bestTask.length) {
      best = mention
      bestTask = task
    }
  }
  return { ...best, task: bestTask }
}

function listMentions<T extends MentionFriend>(
  text: string,
  friends: T[],
  options: { excludeIds?: string[] },
): MentionMatch<T>[] {
  if (!text) return []
  const normalized = text.replace(/＠/g, '@')
  const exclude = new Set(options.excludeIds ?? [])
  const candidates = friends
    .filter((friend) => friend.name.trim() && !exclude.has(friend.id))
    .sort((a, b) => b.name.trim().length - a.name.trim().length)
  if (candidates.length === 0) return []
  const mentions: MentionMatch<T>[] = []
  for (let at = normalized.indexOf('@'); at >= 0; at = normalized.indexOf('@', at + 1)) {
    const previous = at > 0 ? normalized[at - 1] ?? '' : ''
    if (previous && /[A-Za-z0-9._%+-]/.test(previous)) continue
    let cursor = at + 1
    while (cursor < normalized.length && /\s/.test(normalized[cursor] ?? '')) cursor += 1
    const rest = normalized.slice(cursor)
    const friend = candidates.find((item) => rest.startsWith(item.name.trim()))
    if (!friend) continue
    const end = cursor + friend.name.trim().length
    mentions.push({ friend, start: at, end, task: '' })
    at = end - 1
  }
  return mentions
}
