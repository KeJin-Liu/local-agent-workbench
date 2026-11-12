/**
 * 回忆一条会话已经存下来的摘要和最近消息。摘要的生成留到后面。
 */

import type { Message, Summary } from '../domain/types.ts'
import type { Repos } from '../storage/repos/index.ts'

export type RecallResult = {
  conversationId: string
  summary: Summary | null
  recentMessages: Message[]
}

/** @param repos 本地仓库 */
export async function recall(repos: Repos, conversationId: string, limit = 20): Promise<RecallResult> {
  const [summary, messages, runs] = await Promise.all([
    repos.summaries.latest(conversationId),
    repos.messages.listByConversation(conversationId),
    repos.runs.listByConversation(conversationId),
  ])
  const dropped = new Set(runs.filter((run) => run.status === 'cancelled').map((run) => run.id))
  const visible = messages.filter((message) => !message.runId || !dropped.has(message.runId))
  const cap = Math.max(0, limit)
  return {
    conversationId,
    summary: summary ?? null,
    recentMessages: visible.slice(-cap),
  }
}
