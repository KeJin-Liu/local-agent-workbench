/**
 * 会话消息。按 conversationId 取出后按时间排，供以后的发送和回忆使用。
 */

import type { Message } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

/** @param database 已打开的本地库 */
export function createMessageRepo(database: WorkbenchDatabase) {
  const collection = createCollection<Message>(database, 'messages')
  return {
    put: collection.put,
    /** 按 id 删除一条消息。 */
    async delete(id: string): Promise<void> {
      await database.update((draft) => {
        draft.stores.messages = draft.stores.messages.filter((item) => item.id !== id)
      })
    },
    /** 删掉某次 run 写下的用户消息和半成品回复。 */
    async deleteByRun(runId: string): Promise<void> {
      await database.update((draft) => {
        draft.stores.messages = draft.stores.messages.filter((item) => item.runId !== runId)
      })
    },
    /** 同一会话内按 createdAt 升序。 */
    async listByConversation(conversationId: string): Promise<Message[]> {
      const document = await database.read()
      return document.stores.messages
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },
  }
}
