/**
 * 会话摘要。现在只读最新一条，真正的摘要写入留到记忆阶段。
 */

import type { Summary } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'

/** @param database 已打开的本地库 */
export function createSummaryRepo(database: WorkbenchDatabase) {
  return {
    /** @param conversationId 会话 id */
    async listByConversation(conversationId: string): Promise<Summary[]> {
      const document = await database.read()
      return document.stores.summaries
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    /** @param conversationId 会话 id */
    async latest(conversationId: string): Promise<Summary | undefined> {
      const document = await database.read()
      return document.stores.summaries
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .at(-1)
    },

    /** @param summary 摘要记录 */
    async put(summary: Summary): Promise<void> {
      await database.update((draft) => {
        const list = draft.stores.summaries
        const index = list.findIndex((item) => item.id === summary.id)
        if (index === -1) list.push(summary)
        else list[index] = summary
      })
    },
  }
}
