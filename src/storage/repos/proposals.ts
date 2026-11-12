/**
 * 会话内确认卡（提案）。摘要事件化需要读全状态，不只 pending。
 */

import type { Proposal } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'

export function createProposalRepo(database: WorkbenchDatabase) {
  return {
    async listByConversation(conversationId: string): Promise<Proposal[]> {
      const document = await database.read()
      return document.stores.proposals
        .filter((item) => item.conversationId === conversationId)
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },
  }
}
