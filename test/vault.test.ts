import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { redactValue } from '../src/logger.ts'
import { createMcpService } from '../src/app/mcp.ts'
import { upsertProvider } from '../src/app/providers.ts'
import { createHost } from '../src/server.ts'
import { openDatabase } from '../src/storage/database.ts'
import { emptyDocument } from '../src/storage/schema.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { createVault, migratePlaintextSecrets } from '../src/vault/service.ts'

describe('保险库和 MCP 配置', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('密文落盘，列表和日志都不含明文', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-vault-'))
    const file = path.join(directory, 'agent_workbench.json')
    const database = await openDatabase(file)
    await seedIfEmpty(database)
    const vault = createVault(database, path.join(directory, 'vault.key'))
    const secret = await vault.upsert({ name: 'DeepSeek 主密钥', kind: 'api-key', apiKey: 'sk-test-secret-value' })
    const listed = await vault.list()
    assert.equal(listed[0]?.name, 'DeepSeek 主密钥')
    assert.equal(JSON.stringify(listed).includes('sk-test-secret-value'), false)
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('sk-test-secret-value'), false)
    const revealed = await vault.reveal(secret.id)
    assert.equal(revealed?.apiKey, 'sk-test-secret-value')

    const repos = createRepos(database)
    const saved = await upsertProvider(repos, {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      vaultEntryId: secret.id,
      enabled: true,
    }, vault)
    assert.equal(saved.vaultEntryId, secret.id)
    assert.equal('apiKey' in saved, false)
    assert.equal(redactValue('apiKey', 'sk-test-secret-value'), '[redacted]')
    assert.equal(redactValue('note', 'sk-live-abcdef'), '[redacted]')

    const mcp = createMcpService(database, (id) => vault.reveal(id))
    const server = await mcp.upsert({
      name: '文件系统',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: false,
      env: [
        { name: 'API_KEY', vaultEntryId: secret.id },
        { name: 'PLAIN', value: 'not-secret' },
      ],
      headers: [{ name: 'Authorization', vaultEntryId: secret.id }],
    })
    assert.equal(server.env[0]?.vaultEntryId, secret.id)
    assert.equal(server.env[1]?.value, 'not-secret')
    assert.equal(server.headers[0]?.vaultEntryId, secret.id)
    assert.equal((await mcp.list()).length, 1)
    await mcp.remove(server.id)
    assert.equal((await mcp.list()).length, 0)
  })

  it('粘贴的密钥只存引用，落盘擦除明文', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-vault-'))
    const file = path.join(directory, 'agent_workbench.json')
    const database = await openDatabase(file)
    await seedIfEmpty(database)
    const vault = createVault(database, path.join(directory, 'vault.key'))
    const repos = createRepos(database)
    const saved = await upsertProvider(repos, {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-pasted-once',
      enabled: true,
    }, vault)
    assert.ok(saved.vaultEntryId)
    assert.equal('apiKey' in saved, false)
    const revealed = await vault.reveal(saved.vaultEntryId!)
    assert.equal(revealed?.apiKey, 'sk-pasted-once')
    await assertNoPlaintext(file, 'sk-pasted-once')

    await database.update((draft) => {
      const provider = draft.stores.providers.find((item) => item.id === 'openai')
      if (provider) (provider as { apiKey?: string }).apiKey = 'sk-should-not-persist'
    })
    await assertNoPlaintext(file, 'sk-should-not-persist')
    const reread = await database.read()
    assert.equal('apiKey' in (reread.stores.providers.find((item) => item.id === 'openai') ?? {}), false)
  })

  it('旧配置里的明文 apiKey 会迁进保险库', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-vault-'))
    const file = path.join(directory, 'agent_workbench.json')
    const document = emptyDocument()
    document.stores.providers.push({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyPolicy: 'required',
      enabled: true,
      apiKey: 'sk-legacy-plain-key',
      apiKeySecretId: 'legacy-ref',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    document.stores.mcpServers.push({
      id: 'mcp-1',
      name: '旧服务',
      enabled: false,
      transport: 'stdio',
      command: 'echo',
      env: [{ name: 'TOKEN', secretId: 'legacy-ref' }],
      headers: [],
      createdAt: 1,
      updatedAt: 1,
    } as never)
    await writeFile(file, JSON.stringify(document))
    const database = await openDatabase(file)
    const vault = createVault(database, path.join(directory, 'vault.key'))
    const moved = await migratePlaintextSecrets(database, vault)
    assert.equal(moved.moved, 1)
    await assertNoPlaintext(file, 'sk-legacy-plain-key')
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      stores: {
        providers: Array<{ apiKey?: string; vaultEntryId?: string; apiKeySecretId?: string }>
        mcpServers: Array<{ env: Array<{ secretId?: string; vaultEntryId?: string }> }>
      }
    }
    const provider = stored.stores.providers[0]
    assert.equal(provider?.apiKey, undefined)
    assert.equal(provider?.apiKeySecretId, undefined)
    assert.ok(provider?.vaultEntryId)
    assert.equal(stored.stores.mcpServers[0]?.env[0]?.secretId, undefined)
    assert.equal(stored.stores.mcpServers[0]?.env[0]?.vaultEntryId, 'legacy-ref')
    const revealed = await vault.reveal(provider!.vaultEntryId!)
    assert.equal(revealed?.apiKey, 'sk-legacy-plain-key')
  })

  it('reveal 接口才返回明文，列表和配置文件都不含明文', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-vault-'))
    const file = path.join(directory, 'agent_workbench.json')
    const host = await createHost({
      dataFile: file,
      uploadDir: path.join(directory, 'avatars'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
    })
    const base = `http://127.0.0.1:${host.port}`
    try {
      const created = await (await fetch(`${base}/api/vault`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '展示用', kind: 'api-key', apiKey: 'sk-ui-reveal' }),
      })).json() as { secret: { id: string } }
      const listed = await (await fetch(`${base}/api/vault`)).text()
      assert.equal(listed.includes('sk-ui-reveal'), false)
      const revealed = await (await fetch(`${base}/api/vault/${created.secret.id}/reveal`, { method: 'POST' })).json() as {
        ok: boolean
        secret: { apiKey?: string }
      }
      assert.equal(revealed.ok, true)
      assert.equal(revealed.secret.apiKey, 'sk-ui-reveal')
      await assertNoPlaintext(file, 'sk-ui-reveal')

      const saved = await (await fetch(`${base}/api/providers/deepseek`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-provider-paste',
          enabled: true,
        }),
      })).json() as { provider: { apiKey?: string; vaultEntryId?: string; hasApiKey: boolean } }
      assert.equal(saved.provider.apiKey, undefined)
      assert.equal(saved.provider.hasApiKey, true)
      assert.ok(saved.provider.vaultEntryId)
      await assertNoPlaintext(file, 'sk-provider-paste')
      const linked = await (await fetch(`${base}/api/vault/${saved.provider.vaultEntryId}/reveal`, { method: 'POST' })).json() as {
        secret: { apiKey?: string }
      }
      assert.equal(linked.secret.apiKey, 'sk-provider-paste')
    } finally {
      await host.close()
    }
  })
})

async function assertNoPlaintext(file: string, secret: string): Promise<void> {
  const raw = await readFile(file, 'utf8')
  assert.equal(raw.includes(secret), false)
  const parsed = JSON.parse(raw) as { stores: { providers: Array<Record<string, unknown>> } }
  for (const provider of parsed.stores.providers) {
    assert.equal(Object.hasOwn(provider, 'apiKey'), false)
  }
}
