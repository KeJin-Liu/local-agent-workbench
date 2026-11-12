/**
 * 手工技能。草稿阶段只按 status 过滤，正文仍是纯文本。
 */

import type { Skill } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

/** @param database 已打开的本地库 */
export function createSkillRepo(database: WorkbenchDatabase) {
  return createCollection<Skill>(database, 'skills')
}
