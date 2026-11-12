/**
 * 本地 JSON 库。写入串行；失败的修改只发生在副本上，不会弄脏已打开的文档。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkbenchDocument } from '../domain/types.ts'
import { log } from '../logger.ts'
import { scrubPersistedSecrets } from './scrub.ts'
import { adoptLegacyStores, assertDocument, emptyDocument } from './schema.ts'

export type WorkbenchDatabase = {
  filePath: string
  read: () => Promise<WorkbenchDocument>
  update: <T>(mutator: (draft: WorkbenchDocument) => T | Promise<T>) => Promise<T>
}

/** 打开或创建库文件。目录不存在时会建出来。 */
export async function openDatabase(filePath: string): Promise<WorkbenchDatabase> {
  await mkdir(path.dirname(filePath), { recursive: true })
  let cache: WorkbenchDocument | null = null
  let chain: Promise<void> = Promise.resolve()

  async function persist(document: WorkbenchDocument): Promise<void> {
    // 任何写入路径都先丢掉提供方上的明文，避免调用方漏删。
    scrubPersistedSecrets(document)
    const temporary = `${filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, filePath)
    log('debug', 'storage', '写入本地库', { filePath })
  }

  async function load(): Promise<WorkbenchDocument> {
    if (cache) return cache
    try {
      const text = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      const migrated = adoptLegacyStores(parsed)
      assertDocument(parsed)
      cache = parsed
      if (migrated) {
        await persist(cache)
        log('info', 'storage', '旧表 roles 已收成 friends', { filePath })
      }
      log('info', 'storage', '打开本地库', { filePath, version: parsed.version })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (code === 'ENOENT') {
        cache = emptyDocument()
        await persist(cache)
        log('info', 'storage', '新建空库', { filePath })
        return cache
      }
      log('error', 'storage', '本地库打不开', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return cache
  }

  function update<T>(mutator: (draft: WorkbenchDocument) => T | Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const current = await load()
      const draft = structuredClone(current)
      const result = await mutator(draft)
      cache = draft
      await persist(draft)
      return result
    })
    // 一次失败不能把后面的写入永远挂起。
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function read(): Promise<WorkbenchDocument> {
    return structuredClone(await load())
  }

  await load()
  return { filePath, read, update }
}
