import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { buildContactDirectory, conversationSegments, directoryEmptyCopy } from '../src/app/directory.ts'
import { createAssignmentService } from '../src/app/assignments.ts'
import { createConversation, listConversations, setGroupArchived, startFreshThread } from '../src/app/conversations.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import type { Conversation, ConversationCard, Friend } from '../src/domain/types.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('通讯录', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('全部是好友加群，同一联系人多段对话只占一行', () => {
    const friends = [friend('role-owner', '群主'), friend('friend-dev', '技术开发')]
    const conversations = [
      card('c-old', 'direct', ['role-owner'], 'friend:role-owner', 1, '旧的'),
      card('c-new', 'direct', ['role-owner'], 'friend:role-owner', 3, '新的'),
      card('g1', 'group', ['role-owner', 'friend-dev'], 'group-1', 2, '群里一句'),
      card('g2', 'group', ['role-owner', 'friend-dev'], 'group-1', 4, '群的新段'),
    ]
    const all = buildContactDirectory(conversations, friends, 'all')
    assert.deepEqual(all.map((row) => row.title), ['群主', '开发群', '技术开发'])
    assert.equal(all.find((row) => row.title === '群主')?.conversation?.id, 'c-new')
    assert.equal(all.find((row) => row.kind === 'group')?.conversation?.id, 'g2')
    assert.equal(all.find((row) => row.title === '技术开发')?.conversation, undefined)
    assert.deepEqual(
      buildContactDirectory(conversations, friends, 'friend').map((row) => row.title),
      ['群主', '技术开发'],
    )
    assert.deepEqual(
      buildContactDirectory(conversations, friends, 'group').map((row) => row.title),
      ['开发群'],
    )
  })

  it('归档的群只出现在归档页签', () => {
    const friends = [friend('role-owner', '群主'), friend('friend-dev', '技术开发')]
    const active = card('g-open', 'group', ['role-owner', 'friend-dev'], 'group-open', 2, '还在聊')
    active.title = '进行中的群'
    const hidden = card('g-old', 'group', ['role-owner', 'friend-dev'], 'group-old', 5, '收起来了')
    hidden.title = '已归档的群'
    hidden.archived = true
    const conversations = [
      card('c-new', 'direct', ['role-owner'], 'friend:role-owner', 3, '新的'),
      active,
      hidden,
    ]
    assert.deepEqual(
      buildContactDirectory(conversations, friends, 'all').map((row) => row.title),
      ['群主', '进行中的群', '技术开发'],
    )
    assert.deepEqual(buildContactDirectory(conversations, friends, 'group').map((row) => row.title), ['进行中的群'])
    assert.deepEqual(buildContactDirectory(conversations, friends, 'archive').map((row) => row.title), ['已归档的群'])
    assert.equal(directoryEmptyCopy('archive', '', 2, 1), '还没有归档的群。')
  })

  it('归档写到同一群的每一段，另起一段仍保持归档', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-dir-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const dev: Friend = { ...owner, id: 'friend-dev', name: '技术开发', isOwnerTemplate: false }
    await repos.friends.put(dev)
    const group = await createConversation(repos, '开发群', { kind: 'group', friendIds: [owner.id, dev.id] })
    const fresh = await startFreshThread(repos, group.id)
    const archived = await setGroupArchived(repos, group.id, true)
    assert.equal(archived.archived, true)
    assert.equal((await repos.conversations.get(fresh.id))?.archived, true)
    const direct = (await listConversations(repos)).find((item) => item.kind === 'direct')
    assert.ok(direct)
    await assert.rejects(() => setGroupArchived(repos, direct.id, true), /只有群聊可以归档/)
    const restored = await setGroupArchived(repos, fresh.id, false)
    assert.equal(restored.archived, undefined)
    assert.equal((await repos.conversations.get(group.id))?.archived, undefined)
    const again = await startFreshThread(repos, fresh.id)
    assert.equal(again.archived, undefined)
  })

  it('归档的群不能发送，也不能指派，取消归档后可以发送', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-dir-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const dev: Friend = { ...owner, id: 'friend-dev', name: '技术开发', isOwnerTemplate: false }
    await repos.friends.put(dev)
    const group = await createConversation(repos, '开发群', { kind: 'group', friendIds: [owner.id, dev.id] })
    await setGroupArchived(repos, group.id, true)
    let calls = 0
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1
        return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
      remember: async () => undefined,
    })
    await assert.rejects(() => turns.sendTurn({ conversationId: group.id, text: '还在吗', delayMs: 0 }), /取消归档后才能继续聊天/)
    assert.equal(calls, 0)
    assert.equal((await repos.messages.listByConversation(group.id)).length, 0)
    const assignments = createAssignmentService(database, async () => '不应执行')
    await assert.rejects(() => assignments.create(group.id, dev.id, '继续改'), /取消归档后才能继续聊天/)
    await repos.friends.put({ ...owner, defaultModelId: 'qwen' })
    await setGroupArchived(repos, group.id, false)
    const sent = await turns.sendTurn({ conversationId: group.id, text: '恢复后可以聊', delayMs: 0 })
    assert.equal(sent.message.content, '恢复后可以聊')
    turns.dispose()
  })

  it('会话列表按 lineage 取回旧段，不会混入别的联系人', () => {
    const conversations = [
      card('c-old', 'direct', ['role-owner'], 'friend:role-owner', 1, '旧的'),
      card('c-new', 'direct', ['role-owner'], 'friend:role-owner', 3, '新的'),
      card('g1', 'group', ['role-owner', 'friend-dev'], 'group-1', 2, '群一'),
      card('g2', 'group', ['role-owner', 'friend-dev'], 'group-1', 4, '群二'),
    ]
    const direct = conversations.find((item) => item.id === 'c-new')
    assert.ok(direct)
    assert.deepEqual(conversationSegments(conversations, direct).map((item) => item.id), ['c-old', 'c-new'])
    const group = conversations.find((item) => item.id === 'g2')
    assert.ok(group)
    assert.deepEqual(conversationSegments(conversations, group).map((item) => item.id), ['g1', 'g2'])
    const other = card('c-other', 'direct', ['friend-dev'], 'friend:friend-dev', 5, '别的')
    assert.deepEqual(conversationSegments([...conversations, other], direct).map((item) => item.id), ['c-old', 'c-new'])
  })

  it('冷启动能看到群主，/new_chat 不增加通讯录行', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-dir-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const friends = (await repos.friends.list()).map((item) => ({ ...item }))
    const before = (await listConversations(repos)).map(asCard)
    const directoryBefore = buildContactDirectory(before, friends, 'all')
    assert.deepEqual(directoryBefore.map((row) => row.title), ['群主'])
    const origin = before[0]
    assert.ok(origin)
    await repos.messages.put({
      id: 'm1',
      conversationId: origin.id,
      role: 'user',
      content: '上一句',
      status: 'complete',
      createdAt: 1,
    })
    const fresh = await startFreshThread(repos, origin.id)
    assert.notEqual(fresh.id, origin.id)
    assert.equal(fresh.lineageId, origin.lineageId)
    assert.equal((await repos.messages.listByConversation(fresh.id)).length, 0)
    assert.equal((await repos.messages.listByConversation(origin.id)).length, 1)
    const after = (await listConversations(repos)).map(asCard)
    const rows = buildContactDirectory(after, friends, 'friend')
    assert.deepEqual(rows.map((row) => row.title), ['群主'])
    assert.equal(rows[0]?.conversation?.id, fresh.id)
  })
})

function friend(id: string, name: string): Friend {
  return {
    id,
    name,
    description: '',
    systemPrompt: '',
    isOwnerTemplate: id === 'role-owner',
    avatar: { kind: 'default', id: 'seal' },
    providerId: 'ollama-local',
    createdAt: 1,
    updatedAt: 1,
  }
}

function card(
  id: string,
  kind: 'direct' | 'group',
  friendIds: string[],
  lineageId: string,
  updatedAt: number,
  preview: string,
): ConversationCard {
  return {
    id,
    title: kind === 'group' ? '开发群' : '群主',
    kind,
    friendIds,
    providerId: 'ollama-local',
    lineageId,
    preview,
    createdAt: updatedAt,
    updatedAt,
  }
}

function asCard(conversation: Conversation): ConversationCard {
  return { ...conversation, preview: '' }
}
