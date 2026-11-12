/**
 * p0.8：会话内 workbench_propose → ConfirmCard
 * 作用域先问清；未确认不落库；取消丢草稿；失败整笔回滚可重试；kind=skill|mcp|task|friend
 * ≠ SkillSuggestion ≠ MCP 市场 enableFromCatalog
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createProposalService, PROPOSE_TOOL } from '../src/app/proposals.ts'
import { createMcpService } from '../src/app/mcp.ts'
import { acceptSkillSuggestion, detectSkillSuggestion } from '../src/app/skill-suggestions.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import type { WorkbenchDatabase } from '../src/storage/database.ts'
import type { ProposalService } from '../src/app/proposals.ts'
import type { Repos } from '../src/storage/repos/index.ts'

describe('p0.8 会话内提议', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('工具名 workbench_propose；kind 含 skill|mcp|task|friend（p1.4 另扩配置 kind）', () => {
    assert.equal(PROPOSE_TOOL.function.name, 'workbench_propose')
    const kinds = (PROPOSE_TOOL.function.parameters as { properties: { kind: { enum: string[] } } }).properties.kind.enum
    for (const kind of ['skill', 'mcp', 'task', 'friend']) assert.ok(kinds.includes(kind), kind)
    for (const kind of ['provider', 'app_settings', 'friend_patch', 'group', 'vault_binding']) {
      assert.ok(kinds.includes(kind), kind)
    }
  })

  it('三种 kind：未确认不落库；确认才写对应集合；取消丢草稿', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const { database, proposals, friendId } = ctx

    const skill = await proposals.stage({
      conversationId: 'c1',
      kind: 'skill',
      name: '验收三步',
      summary: '对照·确认·交包',
      draft: { body: '1.对照 2.确认 3.交包' },
    })
    const mcp = await proposals.stage({
      conversationId: 'c1',
      kind: 'mcp',
      name: 'filesystem',
      summary: 'stdio',
      draft: { transport: 'stdio', command: 'npx demo-fs' },
    })
    const task = await proposals.stage({
      conversationId: 'c1',
      kind: 'task',
      name: '每日站会摘要',
      draft: { friendId, schedule: 'cron', cron: '0 9 * * 1-5', body: '汇总' },
    })

    let doc = await database.read()
    assert.equal(doc.stores.skills.length, 0)
    assert.equal(doc.stores.mcpServers.length, 0)
    assert.equal(doc.stores.tasks.length, 0)
    assert.equal((await proposals.listPending('c1')).length, 3)

    await proposals.confirm(skill.id, 'friends', [friendId])
    await proposals.confirm(mcp.id, 'global', [])
    await proposals.confirm(task.id, 'friends', [friendId])

    doc = await database.read()
    assert.equal(doc.stores.skills.length, 1)
    assert.equal(doc.stores.skills[0]?.scope, 'friends')
    assert.deepEqual(doc.stores.skills[0]?.friendIds, [friendId])
    assert.equal(doc.stores.mcpServers.length, 1)
    assert.equal(doc.stores.mcpServers[0]?.enabled, true)
    assert.equal(doc.stores.mcpServers[0]?.scope, 'global')
    assert.equal(doc.stores.tasks.length, 1)
    assert.equal((await proposals.listPending('c1')).length, 0)

    const draft = await proposals.stage({ conversationId: 'c1', kind: 'skill', name: '丢弃我', draft: { body: 'x' } })
    await proposals.cancel(draft.id)
    doc = await database.read()
    assert.equal(doc.stores.proposals.some((item) => item.id === draft.id), false)
    assert.equal(doc.stores.skills.length, 1)
  })

  it('作用域 friends 空选 → 400 不落库；失败记 error 仍 pending 可重试', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const { database, proposals, friendId } = ctx
    const pending = await proposals.stage({
      conversationId: 'c1',
      kind: 'mcp',
      name: 'broken-fs',
      draft: { transport: 'stdio', command: 'npx demo' },
    })

    await assert.rejects(() => proposals.confirm(pending.id, 'friends', []), /至少选一个/)
    assert.equal((await database.read()).stores.mcpServers.length, 0)

    await assert.rejects(() => proposals.confirm(pending.id, 'friends', ['missing-friend']), /好友/)
    const afterFail = (await database.read()).stores.proposals.find((item) => item.id === pending.id)
    assert.equal(afterFail?.status, 'pending')
    assert.match(afterFail?.error ?? '', /好友|不存在/)
    assert.equal((await database.read()).stores.mcpServers.length, 0)

    const bad = await proposals.stage({
      conversationId: 'c1',
      kind: 'mcp',
      name: 'no-cmd',
      draft: { transport: 'stdio' },
    })
    await assert.rejects(() => proposals.confirm(bad.id, 'global', []), /命令/)
    assert.equal((await database.read()).stores.mcpServers.length, 0)
    assert.equal((await database.read()).stores.proposals.find((item) => item.id === bad.id)?.status, 'pending')

    const ok = await proposals.confirm(pending.id, 'friends', [friendId])
    assert.equal(ok.status, 'confirmed')
    assert.equal((await database.read()).stores.mcpServers.length, 1)
  })

  it('≠ SkillSuggestion 路径；≠ MCP 市场 enableFromCatalog', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const { database, proposals, repos, friendId } = ctx
    const conversationId = 'conv-suggest'
    const providerId = (await database.read()).stores.providers[0]!.id
    await repos.conversations.put({
      id: conversationId,
      title: '区分',
      kind: 'direct',
      friendIds: [friendId],
      providerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) {
      await repos.messages.put({
        id: `m${i}`,
        conversationId,
        role: 'user',
        content: '重复验收三步清单模式',
        status: 'complete',
        createdAt: now - i * 1000,
      })
    }
    const suggestion = await detectSkillSuggestion(repos, conversationId)
    assert.ok(suggestion)
    assert.equal(suggestion!.status, 'pending')
    assert.equal((await database.read()).stores.skills.length, 0)
    assert.equal((await proposals.listPending(conversationId)).length, 0)

    await acceptSkillSuggestion(repos, suggestion!.id, { scope: 'friends', friendIds: [friendId] })
    assert.equal((await database.read()).stores.skills.length, 1)

    const mcp = createMcpService(database, async () => undefined)
    const before = (await database.read()).stores.mcpServers.length
    const catalog = await mcp.listCatalog()
    assert.ok(catalog.length > 0)
    await mcp.enableFromCatalog(catalog[0]!.id, 'global', [])
    assert.equal((await database.read()).stores.mcpServers.length, before + 1)
    assert.equal((await proposals.listPending('any')).length, 0)
  })
})

async function boot(): Promise<{
  directory: string
  database: WorkbenchDatabase
  repos: Repos
  proposals: ProposalService
  friendId: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-p08-'))
  const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
  await seedIfEmpty(database)
  const repos = createRepos(database)
  const proposals = createProposalService(database)
  const friendId = (await database.read()).stores.friends[0]!.id
  return { directory, database, repos, proposals, friendId }
}
