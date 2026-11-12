/**
 * 好友 / 项目长期记忆。按作用域和主人过滤。
 */

import type { LongTermMemory, LongTermMemoryScope, LtmInjectPref } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

export function createLongTermMemoryRepo(database: WorkbenchDatabase) {
  const collection = createCollection<LongTermMemory>(database, 'longTermMemories')
  return {
    ...collection,
    async listByOwner(scope: LongTermMemoryScope, ownerId: string): Promise<LongTermMemory[]> {
      const rows = await collection.list()
      return rows
        .filter((item) => item.scope === scope && item.ownerId === ownerId)
        .sort((a, b) => {
          const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
          if (pin !== 0) return pin
          return b.updatedAt - a.updatedAt
        })
    },
  }
}

export function createLtmInjectPrefRepo(database: WorkbenchDatabase) {
  const collection = createCollection<LtmInjectPref>(database, 'ltmInjectPrefs')
  return {
    ...collection,
    async getFor(scope: LongTermMemoryScope, ownerId: string): Promise<LtmInjectPref | undefined> {
      return collection.get(prefId(scope, ownerId))
    },
  }
}

export function prefId(scope: LongTermMemoryScope, ownerId: string): string {
  return `${scope}:${ownerId}`
}
