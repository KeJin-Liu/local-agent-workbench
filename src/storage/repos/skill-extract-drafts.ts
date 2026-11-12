/**
 * p1.3 会话抽技能待确认草案。
 */

import type { SkillExtractDraft } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

export function createSkillExtractDraftRepo(database: WorkbenchDatabase) {
  const collection = createCollection<SkillExtractDraft>(database, 'skillExtractDrafts')
  return {
    ...collection,
    async listPendingByConversation(conversationId: string): Promise<SkillExtractDraft[]> {
      const rows = await collection.list()
      return rows
        .filter((item) => item.conversationId === conversationId && item.status === 'pending')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
  }
}
