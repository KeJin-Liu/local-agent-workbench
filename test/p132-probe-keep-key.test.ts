import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { applyProbeModelsToFormState } from '../src/ui/provider-probe-form.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.3.2 探测保留 API Key', () => {
  it('applyProbeModelsToFormState 只改 probedModels/默认模型，不清 key 相关字段', () => {
    const before = {
      apiKey: 'sk-live-keep-me',
      clearApiKey: false,
      vaultEntryId: 'vault-1',
      baseUrl: 'https://api.deepseek.com/v1',
      name: 'DeepSeek',
      enabled: true,
      defaultModel: '',
      probedModels: [] as string[],
    }
    const after = applyProbeModelsToFormState(before, ['deepseek-chat', 'deepseek-reasoner'])
    assert.equal(after.apiKey, 'sk-live-keep-me')
    assert.equal(after.clearApiKey, false)
    assert.equal(after.vaultEntryId, 'vault-1')
    assert.equal(after.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal(after.name, 'DeepSeek')
    assert.equal(after.enabled, true)
    assert.deepEqual(after.probedModels, ['deepseek-chat', 'deepseek-reasoner'])
    assert.equal(after.defaultModel, 'deepseek-chat')

    const keptDefault = applyProbeModelsToFormState(
      { ...before, defaultModel: 'deepseek-reasoner', apiKey: 'sk-still' },
      ['deepseek-chat', 'deepseek-reasoner'],
    )
    assert.equal(keptDefault.defaultModel, 'deepseek-reasoner')
    assert.equal(keptDefault.apiKey, 'sk-still')
  })

  it('探测失败路径也不应 reset/clear key：源码约束', async () => {
    const src = await readFile(path.join(root, 'src/ui/provider-settings.tsx'), 'utf8')
    // 表单 key 不得因 probedModels/updatedAt 变化 remount
    assert.match(src, /key=\{selected\.id\}/)
    assert.doesNotMatch(src, /key=\{`\$\{selected\.id\}:\$\{selected\.updatedAt\}/)
    assert.doesNotMatch(src, /probedModels \?\? \[\]\)\.join/)

    // 探测成功不得触发 onSaved（会刷新父级并曾导致 remount 清空 Key）
    const probeFn = src.slice(src.indexOf('async function onProbe'), src.indexOf('return (', src.indexOf('async function onProbe')))
    assert.match(probeFn, /applyProbeModelsToFormState/)
    assert.doesNotMatch(probeFn, /await onSaved\(/)
    assert.doesNotMatch(probeFn, /setApiKey\(['"]['"]\)/)
    assert.doesNotMatch(probeFn, /setClearApiKey\(true\)/)
    assert.doesNotMatch(probeFn, /setVaultEntryId\(['"]['"]\)/)
    assert.doesNotMatch(probeFn, /setBaseUrl\(/)

    // 失败分支同样不清 Key
    assert.match(probeFn, /setProbe\(\{ ok: false/)
    assert.doesNotMatch(probeFn, /setApiKey\(''\)/)
  })

  it('rememberProbedModels 不碰 vaultEntryId', async () => {
    const providers = await readFile(path.join(root, 'src/app/providers.ts'), 'utf8')
    const fn = providers.slice(providers.indexOf('export async function rememberProbedModels'), providers.indexOf('function uniqueModelIds'))
    assert.match(fn, /existing\.vaultEntryId/)
    assert.doesNotMatch(fn, /vaultEntryId:\s*undefined/)
    assert.doesNotMatch(fn, /clearSecret|clearApiKey|apiKey:/)
  })

  it('UI 定稿：探测旁说明 + 失败/成功文案强调不清 Key', async () => {
    const src = await readFile(path.join(root, 'src/ui/provider-settings.tsx'), 'utf8')
    assert.match(src, /probe-keep-help/)
    assert.match(src, /探测只刷新模型列表，不会清空 API Key/)
    assert.match(src, /表单凭证未改动/)
    assert.match(src, /不会被清空/)
    assert.match(src, /探测不清 Key/)
    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.probe-keep-help/)
    assert.match(css, /\.probe-status-note/)
  })

})
