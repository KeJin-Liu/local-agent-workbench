/**
 * 会话，以及挂在它下面的消息、运行、摘要和指派。
 */

import type { Conversation } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

/** @param database 已打开的本地库 */
export function createConversationRepo(database: WorkbenchDatabase) {
  const collection = createCollection<Conversation>(database, 'conversations')
  return {
    list: collection.list,
    get: collection.get,
    put: collection.put,
    /**
     * 一次更新里删掉会话和它名下的行，避免留下孤儿。
     * 技能不属于某一条会话，所以不动 skills。
     */
    async deleteCascade(id: string): Promise<void> {
      await database.update((draft) => {
        draft.stores.messages = draft.stores.messages.filter((item) => item.conversationId !== id)
        draft.stores.runs = draft.stores.runs.filter((item) => item.conversationId !== id)
        draft.stores.summaries = draft.stores.summaries.filter((item) => item.conversationId !== id)
        draft.stores.assignments = draft.stores.assignments.filter((item) => item.conversationId !== id)
        draft.stores.conversations = draft.stores.conversations.filter((item) => item.id !== id)
      })
    },
  }
}
