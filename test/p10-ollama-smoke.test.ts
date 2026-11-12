/**
 * p1.0：本机 Ollama 探测冒烟。默认探测；不可达则 skip（不挡 CI）。
 * 强制跑：OLLAMA_SMOKE=1（不可达则失败）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { listModels } from '../src/llm/client.ts'
import { DEFAULT_OLLAMA_BASE_URL } from '../src/storage/schema.ts'

describe('p1.0 Ollama 探测冒烟', () => {
  it('listModels 对本地 /v1；不可达则跳过', async () => {
    const forced = process.env.OLLAMA_SMOKE === '1'
    try {
      const models = await listModels({ baseUrl: DEFAULT_OLLAMA_BASE_URL, timeoutMs: 2_000 })
      assert.ok(models.length > 0, 'Ollama 已响应但模型列表为空，请先 ollama pull')
    } catch (error) {
      if (forced) throw error
      // skip
      console.log('skip Ollama smoke:', error instanceof Error ? error.message : String(error))
    }
  })
})
