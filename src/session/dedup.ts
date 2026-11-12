/**
 * 防重的耐久查询。队列只挡当前进程，这里挡已经写进库的 run。
 */

import type { Run } from '../domain/types.ts'
import type { Repos } from '../storage/repos/index.ts'

/** @param repos 本地仓库 */
export async function findExistingRun(repos: Repos, idempotencyKey: string): Promise<Run | undefined> {
  return repos.runs.findByIdempotency(idempotencyKey)
}
