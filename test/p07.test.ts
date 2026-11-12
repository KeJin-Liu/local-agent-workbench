/**
 * p0.7：思维链 reasoning 落库与 thread 回读；无 reasoning 不写字段；回灌不含 reasoning。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()

let directory = ''

describe('p0.7 思维链', () => {
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('流式 reasoning 落库；无 reasoning 不出现字段；历史回灌 content 不含 reasoning', async () => {
    const { repos } = await boot()
    let streamCalls = 0
    const seenAssistantContents: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 15,
      remember: async () => undefined,
      fetchImpl: async (_input, init) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { stream?: boolean; messages?: Array<{ role: string; content: string }> })
          : null
        if (body?.messages) {
          for (const item of body.messages) {
            if (item.role === 'assistant') seenAssistantContents.push(item.content)
          }
        }
        if (!body?.stream) {
          return new Response(JSON.stringify({ model: 'mock', choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }), {
            status: 200,
          })
        }
        streamCalls += 1
        const stream = new ReadableStream({
          start(controller) {
            if (streamCalls === 1) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"内部推理A"}}]}\n'))
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"B"}}]}\n'))
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"正式"}}]}\n'))
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"回复"}}]}\n\ndata: [DONE]\n'))
            } else {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"纯气泡"}}]}\n\ndata: [DONE]\n'))
            }
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    })

    const conversation = await createConversation(repos, '思维链')
    const sent1 = await orchestrator.sendTurn({ conversationId: conversation.id, text: '带思维链', model: 'mock-reasoner' })
    assert.equal(sent1.run.status, 'pending')

    let withReason: { content: string; reasoning?: string } | undefined
    for (let i = 0; i < 50; i += 1) {
      await wait(40)
      const messages = await repos.messages.listByConversation(conversation.id)
      withReason = messages.find((m) => m.role === 'assistant' && m.status === 'complete')
      if (withReason) break
    }
    assert.ok(withReason)
    assert.equal(withReason!.content, '正式回复')
    assert.equal(withReason!.reasoning, '内部推理AB')
    // 助手消息先落库、run 后收尾；等 run 真正 done 再发下一条，避免并发下的 409。
    for (let i = 0; i < 50; i += 1) {
      if ((await repos.runs.get(sent1.run.id))?.status === 'done') break
      await wait(20)
    }

    await orchestrator.sendTurn({ conversationId: conversation.id, text: '无思维链', model: 'mock-reasoner' })
    let plain: { content: string; reasoning?: string } | undefined
    for (let i = 0; i < 50; i += 1) {
      await wait(40)
      const messages = await repos.messages.listByConversation(conversation.id)
      const assistants = messages.filter((m) => m.role === 'assistant' && m.status === 'complete')
      plain = assistants.at(-1)
      if (plain?.content === '纯气泡') break
    }
    assert.equal(plain?.content, '纯气泡')
    assert.equal(plain?.reasoning, undefined)
    assert.ok(seenAssistantContents.some((c) => c === '正式回复'))
    assert.ok(seenAssistantContents.every((c) => !c.includes('内部推理')))
    orchestrator.dispose()
  })
})

async function boot() {
  directory = await mkdtemp(path.join(tmpdir(), 'wb-p07-'))
  const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
  await seedIfEmpty(database)
  return { repos: createRepos(database) }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
