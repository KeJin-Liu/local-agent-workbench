/**
 * 模型提供方。Ollama 和 LM Studio 都是 openai-compatible，只是 Base URL 不同。
 */

import type { Provider } from '../../domain/types.ts'
import type { WorkbenchDatabase } from '../database.ts'
import { createCollection } from './collection.ts'

/** @param database 已打开的本地库 */
export function createProviderRepo(database: WorkbenchDatabase) {
  return createCollection<Provider>(database, 'providers')
}
