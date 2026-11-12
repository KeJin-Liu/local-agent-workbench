/**
 * p0.5：MCP 市场启用作用域 + Resources/Prompts 列表。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createMcpService } from '../src/app/mcp.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { createVault } from '../src/vault/service.ts'

describe('p0.5 MCP 市场与 Resources', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function setup() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-p05-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const vault = createVault(database, path.join(directory, 'vault.key'))
    const mcp = createMcpService(database, (id) => vault.reveal(id))
    return { database, mcp }
  }

  it('市场可搜索；未 enable 前目录项不落已配置启用态', async () => {
    const { mcp } = await setup()
    const all = await mcp.listCatalog()
    assert.ok(all.length >= 5)
    assert.equal(all.every((item) => item.enabled === false || typeof item.enabled === 'boolean'), true)
    const hit = await mcp.listCatalog('file')
    assert.ok(hit.some((item) => item.id === 'filesystem'))
    const servers = await mcp.list()
    assert.equal(servers.filter((item) => item.catalogId === 'filesystem' && item.enabled).length, 0)
  })

  it('启用 sheet 确认后才写入；全局与指定好友', async () => {
    const { mcp, database } = await setup()
    const owner = (await database.read()).stores.friends.find((item) => item.isOwnerTemplate)
    assert.ok(owner)

    await assert.rejects(() => mcp.enableFromCatalog('github', 'friends', []), /至少勾选/)

    const globalServer = await mcp.enableFromCatalog('github', 'global', [])
    assert.equal(globalServer.enabled, true)
    assert.equal(globalServer.scope, 'global')
    assert.equal(globalServer.catalogId, 'github')

    const catalog = await mcp.listCatalog('github')
    assert.equal(catalog[0]?.enabled, true)
    assert.equal(catalog[0]?.serverId, globalServer.id)

    // 指定好友可用群主模板 id（种子必有）
    const scoped = await mcp.enableFromCatalog('time', 'friends', [owner.id])
    assert.equal(scoped.scope, 'friends')
    assert.deepEqual(scoped.friendIds, [owner.id])
  })

  it('启用后可列出 Resources / Prompts；选用文案非空', async () => {
    const { mcp } = await setup()
    const server = await mcp.enableFromCatalog('filesystem', 'global', [])
    const resources = await mcp.listResources(server.id)
    const prompts = await mcp.listPrompts(server.id)
    assert.ok(resources.length >= 1)
    assert.ok(resources[0]?.uri)
    assert.ok(prompts.length >= 1)
    assert.ok((prompts[0]?.template || prompts[0]?.description || '').length > 0)
  })
})
