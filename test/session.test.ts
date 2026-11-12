import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { shouldPersistMemory } from '../src/memory/commit.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()

describe('发送与取消', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('发送后立刻有用户消息和 pending run，延迟结束前不会打模型', async () => {
    const { repos } = await boot()
    let calls = 0
    const local = createOrchestrator({
      repos,
      delayMs: 80,
      fetchImpl: async () => {
        calls += 1
        return sse('你好')
      },
      remember: async () => undefined,
    })
    const conversation = await createConversation(repos, '延迟')
    const sent = await local.sendTurn({ conversationId: conversation.id, text: '在吗', model: 'qwen' })
    assert.equal(sent.run.status, 'pending')
    assert.equal(sent.message.content, '在吗')
    assert.equal(sent.message.status, 'pending')
    assert.equal(calls, 0)
    const listed = await repos.messages.listByConversation(conversation.id)
    assert.equal(listed.length, 1)
    await wait(30)
    assert.equal(calls, 0)
    local.dispose()
  })

  it('等待期间取消会撤回消息、交还原文，并且不写记忆', async () => {
    const { repos } = await boot()
    let calls = 0
    const remembered: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 200,
      fetchImpl: async () => {
        calls += 1
        return sse('不该出现')
      },
      remember: async (_repos, run) => {
        remembered.push(run.id)
      },
    })
    const conversation = await createConversation(repos, '取消')
    const sent = await orchestrator.sendTurn({ conversationId: conversation.id, text: '先别发', model: 'qwen' })
    const cancelled = await orchestrator.cancelRun(sent.run.id)
    assert.equal(cancelled.draftText, '先别发')
    assert.equal(cancelled.run.status, 'cancelled')
    await wait(260)
    assert.equal(calls, 0)
    assert.deepEqual(await repos.messages.listByConversation(conversation.id), [])
    assert.deepEqual(await repos.summaries.listByConversation(conversation.id), [])
    assert.deepEqual(remembered, [])
    assert.equal(shouldPersistMemory(cancelled.run), false)
    orchestrator.dispose()
  })

  it('生成过程中取消会中止请求，不留下半成品，也不进记忆', async () => {
    const { repos } = await boot()
    let calls = 0
    const remembered: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 20,
      fetchImpl: async (_input, init) => {
        calls += 1
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'))
              const signal = init?.signal
              const finish = () => controller.close()
              if (signal?.aborted) finish()
              else signal?.addEventListener('abort', finish, { once: true })
            },
          }),
          { status: 200 },
        )
      },
      remember: async (_repos, run) => {
        remembered.push(run.status)
      },
    })
    const conversation = await createConversation(repos, '流式取消')
    const sent = await orchestrator.sendTurn({ conversationId: conversation.id, text: '停', model: 'qwen' })
    await waitFor(async () => calls === 1)
    const cancelled = await orchestrator.cancelRun(sent.run.id)
    await wait(40)
    assert.equal(cancelled.draftText, '停')
    assert.equal(cancelled.run.status, 'cancelled')
    assert.deepEqual(await repos.messages.listByConversation(conversation.id), [])
    assert.deepEqual(await repos.summaries.listByConversation(conversation.id), [])
    assert.deepEqual(remembered, [])
    orchestrator.dispose()
  })

  it('正常走完才会进入记忆入口', async () => {
    const { repos } = await boot()
    const remembered: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 15,
      fetchImpl: async () => sse('你好'),
      remember: async (_repos, run) => {
        remembered.push(run.status)
      },
    })
    const conversation = await createConversation(repos, '完成')
    const sent = await orchestrator.sendTurn({ conversationId: conversation.id, text: '在吗', model: 'qwen' })
    await waitFor(async () => (await repos.runs.get(sent.run.id))?.status === 'done')
    const messages = await repos.messages.listByConversation(conversation.id)
    assert.deepEqual(
      messages.map((item) => item.role),
      ['user', 'assistant'],
    )
    assert.equal(messages[1]?.content, '你好')
    assert.deepEqual(remembered, ['done'])
    orchestrator.dispose()
  })

  async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-turn-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    return { repos }
  }
})

function sse(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const payload = JSON.stringify({ choices: [{ delta: { content: text } }] })
        controller.enqueue(encoder.encode(`data: ${payload}\n\ndata: [DONE]\n`))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => Promise<boolean> | boolean) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    if (await check()) return
    await wait(15)
  }
  throw new Error('等待超时')
}
