/**
 * 群主指派。删会话时要和消息一起清掉。
 */

import type { Assignment } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'

/** @param database 已打开的本地库 */
export function createAssignmentRepo(database: WorkbenchDatabase) {
  return {
    /** @param conversationId 会话 id */
    async listByConversation(conversationId: string): Promise<Assignment[]> {
      const document = await database.read()
      return document.stores.assignments
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    /** @param assignment 指派记录 */
    async put(assignment: Assignment): Promise<void> {
      await database.update((draft) => {
        const list = draft.stores.assignments
        const index = list.findIndex((item) => item.id === assignment.id)
        if (index === -1) list.push(assignment)
        else list[index] = assignment
      })
    },
  }
}
