/**
 * 一次模型调用。idempotencyKey 在库内唯一，是以后防重的耐久半边。
 */

import type { Run } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'

/** @param database 已打开的本地库 */
export function createRunRepo(database: WorkbenchDatabase) {
  return {
    /** @param id run id */
    async get(id: string): Promise<Run | undefined> {
      const document = await database.read()
      return document.stores.runs.find((item) => item.id === id)
    },

    async list(): Promise<Run[]> {
      const document = await database.read()
      return [...document.stores.runs]
    },

    /** @param conversationId 会话 id */
    async listByConversation(conversationId: string): Promise<Run[]> {
      const document = await database.read()
      return document.stores.runs
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    /** @param idempotencyKey 回合幂等键 */
    async findByIdempotency(idempotencyKey: string): Promise<Run | undefined> {
      const document = await database.read()
      return document.stores.runs.find((item) => item.idempotencyKey === idempotencyKey)
    },

    /**
     * 写入一条 run。别的 id 已经占用同一个幂等键时拒绝，用来挡住重复发送。
     */
    async put(run: Run): Promise<void> {
      await database.update((draft) => {
        const list = draft.stores.runs
        const clash = list.find((item) => item.idempotencyKey === run.idempotencyKey && item.id !== run.id)
        if (clash) {
          const error = new Error('幂等键已存在')
          ;(error as Error & { code: string }).code = 'duplicate-run'
          throw error
        }
        const index = list.findIndex((item) => item.id === run.id)
        if (index === -1) list.push(run)
        else list[index] = run
      })
    },
  }
}
