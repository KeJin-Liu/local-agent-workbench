/**
 * p0.9：分层记忆 — 工作 / 摘要 / 长期可辨；注入来源；摘要 ≠ LTM；取消不写
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { createLongTermMemory, formatLongTermMemorySystemPrompt } from '../src/app/long-term-memory.ts'
import { createProposalService } from '../src/app/proposals.ts'
import { persistTurnMemory, shouldPersistMemory, writeSummary } from '../src/memory/commit.ts'
import { buildMemoryInject, countWorkingMessages } from '../src/memory/inject.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { loadThread } from '../src/app/conversations.ts'
import type { Message, Run } from '../src/domain/types.ts'

describe('p0.9 layered memory', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('工作记忆计数与注入快照区分摘要 / 好友长期 / 项目长期', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friend = ctx.friends[0]!
    const conversation = await createConversation(ctx.repos, '分层', {
      kind: 'direct',
      friendIds: [friend.id],
    })
    const now = Date.now()
    await ctx.repos.messages.put({
      id: 'm1',
      conversationId: conversation.id,
      role: 'user',
      content: '记住分层',
      status: 'complete',
      createdAt: now,
    })
    await ctx.repos.messages.put({
      id: 'm2',
      conversationId: conversation.id,
      role: 'assistant',
      content: '好的',
      status: 'complete',
      createdAt: now + 1,
    })
    await writeSummary(ctx.repos, conversation.id, 'manual', true)
    await createLongTermMemory(ctx.repos, {
      scope: 'friend',
      ownerId: friend.id,
      fact: '摘要与长期必须区分',
    })
    const messages = await ctx.repos.messages.listByConversation(conversation.id)
    assert.equal(countWorkingMessages(messages), 2)
    const summary = await ctx.repos.summaries.latest(conversation.id)
    const { inject } = await buildMemoryInject(ctx.repos, conversation, messages, summary)
    assert.equal(inject.workingCount, 2)
    assert.equal(inject.summary, true)
    assert.equal(inject.ltmFriendCount, 1)
    assert.equal(inject.ltmProjectCount, 0)
    const thread = await loadThread(ctx.repos, conversation.id)
    assert.ok(thread.memoryInject)
    assert.equal(thread.memoryInject?.workingCount, 2)
    assert.equal(thread.memoryInject?.summary, true)
  })

  it('摘要 system 文案与长期 system 文案不同（摘要 ≠ LTM）', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friend = ctx.friends[0]!
    const memory = await createLongTermMemory(ctx.repos, {
      scope: 'friend',
      ownerId: friend.id,
      fact: '跨会话事实',
    })
    const ltmPrompt = formatLongTermMemorySystemPrompt([memory])
    assert.match(ltmPrompt, /长期记忆/)
    assert.match(ltmPrompt, /与会话摘要分开/)
    assert.doesNotMatch(ltmPrompt, /这段会话已写入记忆的摘要/)
    const summaryLine =
      '以下是这段会话已写入记忆的摘要。后续回答沿用它，不要要求用户重复背景。\n要点'
    assert.match(summaryLine, /会话已写入记忆的摘要/)
    assert.doesNotMatch(summaryLine, /跨会话持久/)
  })

  it('取消 / 失败回合不写摘要；done 才 persist', () => {
    const base = {
      id: 'r1',
      conversationId: 'c1',
      status: 'cancelled' as const,
      idempotencyKey: 'k',
      providerId: 'ollama',
      model: 'm',
      createdAt: 1,
    }
    assert.equal(shouldPersistMemory(base), false)
    assert.equal(shouldPersistMemory({ ...base, status: 'error' }), false)
    assert.equal(shouldPersistMemory({ ...base, status: 'done' }), true)
  })

  it('助手消息可挂 memoryInject；取消不调用 persist 时库中无自动摘要', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friend = ctx.friends[0]!
    const conversation = await createConversation(ctx.repos, '写入感知', { friendIds: [friend.id] })
    const run: Run = {
      id: 'run-cancel',
      conversationId: conversation.id,
      status: 'cancelled',
      idempotencyKey: 'x',
      providerId: friend.providerId,
      model: 'qwen',
      createdAt: Date.now(),
    }
    await persistTurnMemory(ctx.repos, run)
    assert.equal(await ctx.repos.summaries.latest(conversation.id), undefined)

    const assistant: Message = {
      id: 'a1',
      conversationId: conversation.id,
      role: 'assistant',
      content: '分层已可见',
      status: 'complete',
      memoryInject: {
        workingCount: 3,
        summary: true,
        ltmFriendCount: 1,
        ltmProjectCount: 0,
      },
      createdAt: Date.now(),
    }
    await ctx.repos.messages.put(assistant)
    const again = (await ctx.repos.messages.listByConversation(conversation.id)).find((item) => item.id === assistant.id)
    assert.equal(again?.memoryInject?.workingCount, 3)
    assert.equal(again?.memoryInject?.summary, true)
    assert.equal(again?.memoryInject?.ltmFriendCount, 1)
  })
})

async function boot() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-p09-'))
  const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
  await seedIfEmpty(database)
  const repos = createRepos(database)
  const friends = await repos.friends.list()
  return { directory, database, repos, friends, proposals: createProposalService(database) }
}
