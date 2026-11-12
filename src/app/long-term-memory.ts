/**
 * 好友 / 项目长期记忆 CRUD，以及后续回合可注入的条目。
 */

import type { Conversation, LongTermMemory, LongTermMemoryScope, LtmInjectPref } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { prefId } from '../storage/repos/long-term-memories.ts'
import { AppError } from './errors.ts'

export type LongTermMemoryInput = {
  scope: LongTermMemoryScope
  ownerId: string
  fact: string
  source?: 'auto' | 'manual'
  injectEnabled?: boolean
  pinned?: boolean
}

export type LongTermMemoryPatch = {
  fact?: string
  injectEnabled?: boolean
  pinned?: boolean
}

/** 列出某个主人下的记忆。 */
export async function listLongTermMemories(
  repos: Repos,
  scope: LongTermMemoryScope,
  ownerId: string,
): Promise<LongTermMemory[]> {
  if (!ownerId.trim()) throw new AppError(400, '要带上 ownerId。')
  if (scope !== 'friend' && scope !== 'project') throw new AppError(400, '作用域不正确。')
  return repos.longTermMemories.listByOwner(scope, ownerId)
}

/** 手动添加一条。 */
export async function createLongTermMemory(repos: Repos, input: LongTermMemoryInput): Promise<LongTermMemory> {
  const scope = input.scope
  const ownerId = input.ownerId.trim()
  const fact = input.fact.trim()
  if (scope !== 'friend' && scope !== 'project') throw new AppError(400, '作用域不正确。')
  if (!ownerId) throw new AppError(400, '要带上 ownerId。')
  if (!fact) throw new AppError(400, '记忆内容不能为空。')
  await assertOwner(repos, scope, ownerId)
  const now = Date.now()
  const row: LongTermMemory = {
    id: crypto.randomUUID(),
    scope,
    ownerId,
    fact,
    source: input.source ?? 'manual',
    injectEnabled: input.injectEnabled !== false,
    ...(input.pinned ? { pinned: true } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await repos.longTermMemories.put(row)
  log('info', 'ltm', '添加长期记忆', { id: row.id, scope, ownerId })
  return row
}

/** 改事实、注入开关或置顶。 */
export async function updateLongTermMemory(
  repos: Repos,
  id: string,
  patch: LongTermMemoryPatch,
): Promise<LongTermMemory> {
  const current = await repos.longTermMemories.get(id)
  if (!current) throw new AppError(404, '找不到这条长期记忆')
  const next: LongTermMemory = {
    ...current,
    updatedAt: Date.now(),
  }
  if (patch.fact !== undefined) {
    const fact = patch.fact.trim()
    if (!fact) throw new AppError(400, '记忆内容不能为空。')
    next.fact = fact
  }
  if (patch.injectEnabled !== undefined) next.injectEnabled = patch.injectEnabled
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true
    else delete next.pinned
  }
  await repos.longTermMemories.put(next)
  log('info', 'ltm', '更新长期记忆', { id })
  return next
}

export async function deleteLongTermMemory(repos: Repos, id: string): Promise<void> {
  const current = await repos.longTermMemories.get(id)
  if (!current) throw new AppError(404, '找不到这条长期记忆')
  await repos.longTermMemories.delete(id)
  log('info', 'ltm', '删除长期记忆', { id })
}

export async function getLtmInjectPref(
  repos: Repos,
  scope: LongTermMemoryScope,
  ownerId: string,
): Promise<LtmInjectPref> {
  const existing = await repos.ltmInjectPrefs.getFor(scope, ownerId)
  if (existing) return existing
  return {
    id: prefId(scope, ownerId),
    scope,
    ownerId,
    injectEnabled: true,
    updatedAt: Date.now(),
  }
}

export async function setLtmInjectPref(
  repos: Repos,
  scope: LongTermMemoryScope,
  ownerId: string,
  injectEnabled: boolean,
): Promise<LtmInjectPref> {
  if (scope !== 'friend' && scope !== 'project') throw new AppError(400, '作用域不正确。')
  if (!ownerId.trim()) throw new AppError(400, '要带上 ownerId。')
  await assertOwner(repos, scope, ownerId)
  const pref: LtmInjectPref = {
    id: prefId(scope, ownerId),
    scope,
    ownerId,
    injectEnabled,
    updatedAt: Date.now(),
  }
  await repos.ltmInjectPrefs.put(pref)
  log('info', 'ltm', '更新作用域注入开关', { scope, ownerId, injectEnabled })
  return pref
}

/**
 * 当前会话应注入的长期记忆。好友单聊注入该好友；群聊注入项目（lineage）以及发言好友。
 * 作用域总开关关闭时整组不注入；条目 injectEnabled=false 也不注入。
 */
export async function listInjectableForConversation(
  repos: Repos,
  conversation: Conversation,
): Promise<{ memories: LongTermMemory[]; friendCount: number; projectCount: number }> {
  const friendId = conversation.friendIds[0]
  const projectOwner = conversation.kind === 'group' ? conversation.lineageId || conversation.id : ''
  const buckets: LongTermMemory[] = []
  let friendCount = 0
  let projectCount = 0

  if (friendId) {
    const pref = await getLtmInjectPref(repos, 'friend', friendId)
    if (pref.injectEnabled) {
      const rows = (await repos.longTermMemories.listByOwner('friend', friendId)).filter((item) => item.injectEnabled)
      friendCount = rows.length
      buckets.push(...rows)
    }
  }
  if (projectOwner) {
    const pref = await getLtmInjectPref(repos, 'project', projectOwner)
    if (pref.injectEnabled) {
      const rows = (await repos.longTermMemories.listByOwner('project', projectOwner)).filter((item) => item.injectEnabled)
      projectCount = rows.length
      buckets.push(...rows)
    }
  }

  const seen = new Set<string>()
  const memories = buckets.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return { memories, friendCount, projectCount }
}

/** 拼成单独一条系统消息，明确与会话摘要区分。 */
export function formatLongTermMemorySystemPrompt(memories: LongTermMemory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map((item) => {
    const tag = item.scope === 'friend' ? '好友' : '项目/群'
    return `- [${tag}] ${item.fact}`
  })
  return ['以下是好友/项目的长期记忆（跨会话持久事实，与会话摘要分开）。后续回答沿用它们，不要要求用户重复。', ...lines].join(
    '\n',
  )
}

export function projectOwnerId(conversation: Conversation): string {
  return conversation.lineageId || conversation.id
}

async function assertOwner(repos: Repos, scope: LongTermMemoryScope, ownerId: string): Promise<void> {
  if (scope === 'friend') {
    const friend = await repos.friends.get(ownerId)
    if (!friend) throw new AppError(400, '要挂上的好友不存在。')
    return
  }
  const conversations = await repos.conversations.list()
  const hit = conversations.some((item) => item.kind === 'group' && (item.lineageId === ownerId || item.id === ownerId))
  if (!hit) throw new AppError(400, '要挂上的项目/群不存在。')
}
