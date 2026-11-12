/**
 * 中间栏是通讯录：一个好友一行，一个群一行。
 * 同一联系人可以有多段对话，列表只挂最新的一段。
 */

import type { ConversationCard, Friend } from '../domain/types.ts'
import { OWNER_FRIEND_ID } from '../storage/schema.ts'

export type ContactFilter = 'all' | 'friend' | 'group' | 'archive'

export type ContactRow = {
  key: string
  kind: 'friend' | 'group'
  title: string
  friend?: Friend
  /** 最新一段对话。还没点开过的好友没有这段。 */
  conversation?: ConversationCard
  preview: string
  updatedAt: number
}

/** 单聊且只挂这一个好友。 */
export function directChatsFor(friendId: string, conversations: ConversationCard[]): ConversationCard[] {
  return conversations
    .filter((item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === friendId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
}

/** 群的稳定键。旧数据没有 lineageId 时，用会话自己的 id。 */
export function groupLineage(conversation: ConversationCard): string {
  return conversation.lineageId || conversation.id
}

/** 每个群只留最新一段。 */
export function latestGroups(conversations: ConversationCard[]): ConversationCard[] {
  const newest = new Map<string, ConversationCard>()
  for (const conversation of conversations) {
    if (conversation.kind !== 'group') continue
    const key = groupLineage(conversation)
    const previous = newest.get(key)
    if (!previous || conversation.updatedAt > previous.updatedAt) newest.set(key, conversation)
  }
  return [...newest.values()]
}

function toGroupRow(conversation: ConversationCard, friends: Friend[]): ContactRow {
  const friend = friends.find((item) => item.id === conversation.friendIds[0])
  return {
    key: `group:${groupLineage(conversation)}`,
    kind: 'group' as const,
    title: conversation.title,
    preview: conversation.preview || '还没有消息',
    updatedAt: conversation.updatedAt,
    conversation,
    ...(friend ? { friend } : {}),
  }
}

/** 按页签组装通讯录。全部 = 好友 + 未归档的群，不是历史会话流水。归档只放已归档的群。 */
export function buildContactDirectory(
  conversations: ConversationCard[],
  friends: Friend[],
  filter: ContactFilter,
): ContactRow[] {
  const friendRows: ContactRow[] = friends.map((friend) => {
    const conversation = directChatsFor(friend.id, conversations)[0]
    return {
      key: `friend:${friend.id}`,
      kind: 'friend' as const,
      title: friend.name,
      friend,
      preview: conversation?.preview || '还没有消息',
      updatedAt: conversation?.updatedAt ?? friend.updatedAt,
      ...(conversation ? { conversation } : {}),
    }
  })
  const groups = latestGroups(conversations)
  const groupRows = groups.filter((conversation) => !conversation.archived).map((conversation) => toGroupRow(conversation, friends))
  const archivedRows = groups.filter((conversation) => conversation.archived).map((conversation) => toGroupRow(conversation, friends))
  const rows =
    filter === 'friend'
      ? friendRows
      : filter === 'group'
        ? groupRows
        : filter === 'archive'
          ? archivedRows
          : [...friendRows, ...groupRows]
  return rows.sort((a, b) => {
    const aOwner = a.kind === 'friend' && a.friend?.id === OWNER_FRIEND_ID ? 1 : 0
    const bOwner = b.kind === 'friend' && b.friend?.id === OWNER_FRIEND_ID ? 1 : 0
    if (aOwner !== bOwner) return bOwner - aOwner
    return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh')
  })
}

/** 当前打开的对话属于哪一行。换一段对话时行不变。 */
export function contactRowIsOpen(row: ContactRow, current: ConversationCard | undefined): boolean {
  if (!current) return false
  if (row.kind === 'friend') {
    return current.kind === 'direct' && current.friendIds.length === 1 && current.friendIds[0] === row.friend?.id
  }
  return current.kind === 'group' && groupLineage(current) === (row.conversation ? groupLineage(row.conversation) : '')
}

export function directoryEmptyCopy(filter: ContactFilter, query: string, friendCount: number, groupCount: number): string {
  if (query.trim()) return `没有匹配「${query.trim()}」的联系人。`
  if (filter === 'archive') return '还没有归档的群。'
  if (filter === 'group' || (filter === 'all' && friendCount === 0 && groupCount === 0)) {
    return filter === 'group' ? '还没有群组。点右上角加号发起群聊。' : '还没有好友。点右上角加号新建。'
  }
  if (filter === 'friend' && friendCount === 0) return '还没有好友。点右上角加号新建。'
  return '没有可显示的联系人。'
}

/** 同一联系人的所有会话段（旧的在前）；通讯录只显示最新，这里用于「会话列表」切回旧段。 */
export function conversationSegments(
  conversations: ConversationCard[],
  conversation: Pick<ConversationCard, 'id' | 'kind' | 'lineageId'>,
): ConversationCard[] {
  const lineage = conversation.lineageId || conversation.id
  return conversations
    .filter((item) => item.kind === conversation.kind && (item.lineageId || item.id) === lineage)
    .sort((a, b) => a.createdAt - b.createdAt)
}
