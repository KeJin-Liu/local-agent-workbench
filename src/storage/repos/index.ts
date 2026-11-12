/**
 * 把各仓库接到同一个数据库上。用例只依赖这个对象。
 */

import type { WorkbenchDatabase } from '../database.ts'
import { createAssignmentRepo } from './assignments.ts'
import { createConversationRepo } from './conversations.ts'
import { createMessageRepo } from './messages.ts'
import { createProviderRepo } from './providers.ts'
import { createFriendRepo } from './friends.ts'
import { createRunRepo } from './runs.ts'
import { createSkillRepo } from './skills.ts'
import { createSummaryRepo } from './summaries.ts'
import { createLongTermMemoryRepo, createLtmInjectPrefRepo } from './long-term-memories.ts'
import { createSkillSuggestionMuteRepo, createSkillSuggestionRepo } from './skill-suggestions.ts'
import { createProposalRepo } from './proposals.ts'
import { createSkillExtractDraftRepo } from './skill-extract-drafts.ts'

export type Repos = {
  providers: ReturnType<typeof createProviderRepo>
  friends: ReturnType<typeof createFriendRepo>
  conversations: ReturnType<typeof createConversationRepo>
  messages: ReturnType<typeof createMessageRepo>
  runs: ReturnType<typeof createRunRepo>
  summaries: ReturnType<typeof createSummaryRepo>
  skills: ReturnType<typeof createSkillRepo>
  assignments: ReturnType<typeof createAssignmentRepo>
  longTermMemories: ReturnType<typeof createLongTermMemoryRepo>
  ltmInjectPrefs: ReturnType<typeof createLtmInjectPrefRepo>
  skillSuggestions: ReturnType<typeof createSkillSuggestionRepo>
  skillSuggestionMutes: ReturnType<typeof createSkillSuggestionMuteRepo>
  proposals: ReturnType<typeof createProposalRepo>
  skillExtractDrafts: ReturnType<typeof createSkillExtractDraftRepo>
}

/** @param database 已打开的本地库 */
export function createRepos(database: WorkbenchDatabase): Repos {
  return {
    providers: createProviderRepo(database),
    friends: createFriendRepo(database),
    conversations: createConversationRepo(database),
    messages: createMessageRepo(database),
    runs: createRunRepo(database),
    summaries: createSummaryRepo(database),
    skills: createSkillRepo(database),
    assignments: createAssignmentRepo(database),
    longTermMemories: createLongTermMemoryRepo(database),
    ltmInjectPrefs: createLtmInjectPrefRepo(database),
    skillSuggestions: createSkillSuggestionRepo(database),
    skillSuggestionMutes: createSkillSuggestionMuteRepo(database),
    proposals: createProposalRepo(database),
    skillExtractDrafts: createSkillExtractDraftRepo(database),
  }
}
