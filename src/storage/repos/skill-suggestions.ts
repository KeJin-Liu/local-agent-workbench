/**
 * 系统建议技能与静默指纹。建议本身不是正式技能。
 */

import type { SkillSuggestion, SkillSuggestionMute } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

export function createSkillSuggestionRepo(database: WorkbenchDatabase) {
  const collection = createCollection<SkillSuggestion>(database, 'skillSuggestions')
  return {
    ...collection,
    async listPendingByConversation(conversationId: string): Promise<SkillSuggestion[]> {
      const rows = await collection.list()
      return rows
        .filter((item) => item.conversationId === conversationId && item.status === 'pending')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
  }
}

export function createSkillSuggestionMuteRepo(database: WorkbenchDatabase) {
  return createCollection<SkillSuggestionMute>(database, 'skillSuggestionMutes')
}
