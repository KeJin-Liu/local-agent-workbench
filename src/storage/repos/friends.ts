/**
 * 好友。群主模板用 isOwnerTemplate 标出。头像跟记录走，不单独建表。
 */

import type { Friend } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

/** @param database 已打开的本地库 */
export function createFriendRepo(database: WorkbenchDatabase) {
  return createCollection<Friend>(database, 'friends')
}
