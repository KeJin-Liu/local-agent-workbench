/**
 * 按 id 存取一张表。会话维度的查询放在各个仓库里。
 */

import type { StoreName } from '../schema.ts'
import type { WorkbenchDatabase } from '../database.ts'

export type Collection<T extends { id: string }> = {
  list: () => Promise<T[]>
  get: (id: string) => Promise<T | undefined>
  put: (record: T) => Promise<void>
  delete: (id: string) => Promise<void>
}

/** 动态表名下的通用读写。具体类型由调用方收窄。 */
export function createCollection<T extends { id: string }>(
  database: WorkbenchDatabase,
  store: StoreName,
): Collection<T> {
  return {
    async list() {
      const document = await database.read()
      return (document.stores[store] as unknown as T[]).slice()
    },
    async get(id) {
      const document = await database.read()
      return (document.stores[store] as unknown as T[]).find((item) => item.id === id)
    },
    async put(record) {
      await database.update((draft) => {
        const list = draft.stores[store] as unknown as T[]
        const index = list.findIndex((item) => item.id === record.id)
        if (index === -1) list.push(record)
        else list[index] = record
      })
    },
    async delete(id) {
      await database.update((draft) => {
        const list = draft.stores[store] as unknown as T[]
        const index = list.findIndex((item) => item.id === id)
        if (index !== -1) list.splice(index, 1)
      })
    },
  }
}
