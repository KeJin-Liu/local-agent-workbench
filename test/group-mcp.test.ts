/**
 * 群聊 MCP：作用域可以是指定群，发送时只对这个群生效。
 * 同一群另起一段仍共用 lineage。全局和指定好友不会被群设置改写。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation, startFreshThread } from '../src/app/conversations.ts'
import { mcpAppliesToChat, createMcpService } from '../src/app/mcp.ts'
import { createProposalService } from '../src/app/proposals.ts'
import type { Friend } from '../src/domain/types.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { createVault } from '../src/vault/service.ts'

describe('群聊 MCP', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  async function setup() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-group-mcp-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const vault = createVault(database, path.join(directory, 'vault.key'))
    const mcp = createMcpService(database, (id) => vault.reveal(id))
    const proposals = createProposalService(database, vault)
    const owner = (await database.read()).stores.friends.find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const other: Friend = {
      ...owner,
      id: 'friend-mcp-b',
      name: '乙',
      isOwnerTemplate: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await repos.friends.put(other)
    const group = await createConversation(repos, '联调群', { kind: 'group', friendIds: [owner.id, other.id] })
    const lineage = group.lineageId || group.id
    return { database, repos, mcp, proposals, owner, other, group, lineage }
  }

  it('市场启用和手建都可以挂到群；别的会话看不到', async () => {
    const { mcp, group, lineage, owner, other } = await setup()
    await assert.rejects(() => mcp.enableFromCatalog('time', 'groups', []), /至少选一个/)
    await assert.rejects(() => mcp.enableFromCatalog('time', 'groups', ['missing-group']), /指定的群不存在/)

    const fromCatalog = await mcp.enableFromCatalog('time', 'groups', [group.id])
    assert.equal(fromCatalog.scope, 'groups')
    assert.deepEqual(fromCatalog.groupIds, [lineage])
    assert.equal(fromCatalog.friendIds, undefined)

    const manual = await mcp.upsert({
      name: '群内文件',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'groups',
      groupIds: [lineage],
    })
    assert.equal(mcpAppliesToChat(manual, { kind: 'group', lineageId: lineage, speakerFriendId: owner.id }), true)
    assert.equal(mcpAppliesToChat(manual, { kind: 'direct', speakerFriendId: owner.id, lineageId: lineage }), false)
    assert.equal(mcpAppliesToChat(fromCatalog, { kind: 'group', lineageId: 'other-lineage', speakerFriendId: owner.id }), false)

    const friendOnly = await mcp.upsert({
      name: '好友时钟',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'friends',
      friendIds: [other.id],
    })
    assert.equal(mcpAppliesToChat(friendOnly, { kind: 'group', lineageId: lineage, speakerFriendId: other.id }), true)
    assert.equal(mcpAppliesToChat(friendOnly, { kind: 'group', lineageId: lineage, speakerFriendId: owner.id }), false)
    assert.equal(mcpAppliesToChat({ scope: 'global' }, { kind: 'direct', speakerFriendId: owner.id }), true)
    assert.equal(mcpAppliesToChat({}, { kind: 'group', lineageId: lineage }), true)

    const globalized = await mcp.upsert({
      id: manual.id,
      name: manual.name,
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'global',
    })
    assert.equal(globalized.scope, 'global')
    assert.equal(globalized.groupIds, undefined)
  })

  it('群设置只改本群绑定；另起一段仍然算这个群', async () => {
    const { mcp, repos, group, lineage, owner } = await setup()
    const second = await createConversation(repos, '另一个群', {
      kind: 'group',
      friendIds: group.friendIds,
    })
    const secondLineage = second.lineageId || second.id
    const here = await mcp.upsert({
      name: '本群',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'groups',
      groupIds: [lineage],
    })
    const there = await mcp.upsert({
      name: '他群',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'groups',
      groupIds: [secondLineage],
    })
    const globalServer = await mcp.upsert({
      name: '全局',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: false,
      scope: 'global',
    })

    await mcp.setGroupBindings(group.id, [here.id, there.id])
    const attached = await mcp.list()
    const byId = new Map(attached.map((item) => [item.id, item]))
    assert.deepEqual(byId.get(here.id)?.groupIds, [lineage])
    assert.ok(byId.get(there.id)?.groupIds?.includes(lineage))
    assert.ok(byId.get(there.id)?.groupIds?.includes(secondLineage))

    await assert.rejects(() => mcp.setGroupBindings(group.id, [globalServer.id]), /全局服务/)
    const kept = await mcp.list()
    assert.ok(kept.find((item) => item.id === here.id)?.groupIds?.includes(lineage))
    const direct = await createConversation(repos, '单聊', { kind: 'direct', friendIds: [owner.id] })
    await assert.rejects(() => mcp.setGroupBindings(direct.id, [here.id]), /只有群聊/)

    await mcp.setGroupBindings(group.id, [])
    const cleared = await mcp.list()
    assert.equal(cleared.find((item) => item.id === here.id)?.groupIds, undefined)
    assert.deepEqual(cleared.find((item) => item.id === there.id)?.groupIds, [secondLineage])

    await mcp.setGroupBindings(group.id, [here.id])
    const fresh = await startFreshThread(repos, group.id)
    assert.equal(fresh.lineageId, lineage)
    const rebound = (await mcp.list()).find((item) => item.id === here.id)
    assert.ok(rebound)
    assert.equal(
      mcpAppliesToChat(rebound, { kind: 'group', lineageId: fresh.lineageId || fresh.id, speakerFriendId: owner.id }),
      true,
    )
  })

  it('确认卡可以把 MCP 挂到群，技能不行', async () => {
    const { database, proposals, group, lineage } = await setup()
    const skillsBefore = (await database.read()).stores.skills.length
    const pending = await proposals.stage({
      conversationId: group.id,
      kind: 'mcp',
      name: '群回声',
      summary: '只给这个群',
      draft: { transport: 'stdio', command: 'node', args: ['echo.js'] },
    })
    const saved = await proposals.confirm(pending.id, 'groups', [], {}, [group.id])
    assert.equal(saved.scope, 'groups')
    assert.deepEqual(saved.groupIds, [lineage])
    const servers = (await database.read()).stores.mcpServers
    assert.equal(servers.length, 1)
    assert.equal(servers[0]?.scope, 'groups')
    assert.deepEqual(servers[0]?.groupIds, [lineage])
    assert.equal(servers[0]?.enabled, true)

    const skill = await proposals.stage({
      conversationId: group.id,
      kind: 'skill',
      name: '不该挂群',
      draft: { body: '一步' },
    })
    await assert.rejects(() => proposals.confirm(skill.id, 'groups', [], {}, [lineage]), /只有 MCP/)
    assert.equal((await database.read()).stores.skills.length, skillsBefore)
    assert.equal((await database.read()).stores.mcpServers.length, 1)
  })
})
