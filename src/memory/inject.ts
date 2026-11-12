/**
 * p0.9：计算本回合注入来源（工作窗 / 摘要 / 长期），供编排挂到助手消息与 thread 预览。
 */

import type { Conversation, LongTermMemory, MemoryInject, Message, Summary } from '../domain/types.ts'
import { listInjectableForConversation } from '../app/long-term-memory.ts'
import type { Repos } from '../storage/repos/index.ts'

/** 计入工作记忆的可见发言（user/assistant，非错误、非指派回流）。 */
export function countWorkingMessages(messages: Message[], excludeIds: Set<string> = new Set()): number {
  return messages.filter((message) => {
    if (excludeIds.has(message.id)) return false
    if (message.role !== 'user' && message.role !== 'assistant') return false
    if (message.status === 'error') return false
    if (message.kind === 'assign' || message.kind === 'result') return false
    return true
  }).length
}

export async function buildMemoryInject(
  repos: Repos,
  conversation: Conversation,
  history: Message[],
  summary: Summary | null | undefined,
  excludeMessageIds: string[] = [],
): Promise<{ inject: MemoryInject; ltmMemories: LongTermMemory[] }> {
  const exclude = new Set(excludeMessageIds)
  const workingCount = countWorkingMessages(history, exclude)
  const summaryOn = Boolean(summary?.injectOnNextTurn && summary.content.trim())
  const ltm = await listInjectableForConversation(repos, conversation)
  const friendIds = new Set(
    ltm.memories.filter((item) => item.scope === 'friend').map((item) => item.id),
  )
  const projectIds = new Set(
    ltm.memories.filter((item) => item.scope === 'project').map((item) => item.id),
  )
  const inject: MemoryInject = {
    workingCount,
    summary: summaryOn,
    ...(summaryOn && summary?.id ? { summaryId: summary.id } : {}),
    ltmFriendCount: [...friendIds].length || ltm.friendCount,
    ltmProjectCount: [...projectIds].length || ltm.projectCount,
    ...(ltm.memories.length ? { ltmIds: ltm.memories.map((item) => item.id) } : {}),
  }
  // Prefer scoped counts from injectable list partitioning
  inject.ltmFriendCount = ltm.friendCount
  inject.ltmProjectCount = ltm.projectCount
  return { inject, ltmMemories: ltm.memories }
}

/** 下一回合「将注入」预览（thread 用）：与生成时同一规则。 */
export async function previewMemoryInject(repos: Repos, conversationId: string): Promise<MemoryInject | null> {
  const conversation = await repos.conversations.get(conversationId)
  if (!conversation) return null
  const [messages, summary] = await Promise.all([
    repos.messages.listByConversation(conversationId),
    repos.summaries.latest(conversationId),
  ])
  const { inject } = await buildMemoryInject(repos, conversation, messages, summary)
  return inject
}
