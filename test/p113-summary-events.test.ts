import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { createProposalService } from '../src/app/proposals.ts'
import type { Message, Proposal } from '../src/domain/types.ts'
import {
  SUMMARY_HARD_CAP_CHARS,
  applySummaryHardCap,
  countSummaryChars,
  summarizeMessages,
  writeSummary,
  type SummaryEvent,
} from '../src/memory/commit.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()
const LONG_MARKER = '【超长原文标记_MUST_NOT_APPEAR_IN_SUMMARY_OR_INJECT】'
const LONG_ASSISTANT = `${LONG_MARKER}${'甲乙丙丁戊己庚辛壬癸'.repeat(40)}这是一段很长的好友回复，包含列表题干与废话，不应整段进入摘要。`

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    conversationId: 'c1',
    status: 'complete',
    createdAt: 1,
    ...partial,
  }
}

describe('p1.1.3 会话摘要事件化', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(target, { recursive: true, force: true })
        return
      } catch {
        await wait(30)
      }
    }
  })

  it('样本：创建好友 + 确认卡 → 事件条目，不含长回复全文', () => {
    const proposals: Proposal[] = [
      {
        id: '5b0e87af-1111-2222-3333-444455556666',
        conversationId: 'c1',
        kind: 'friend',
        name: 'UI 设计',
        summary: '纯 HTML、不接第三方设计平台',
        draft: {
          description: '纯 HTML 稿、无第三方设计平台、可查网素材',
          systemPrompt: '你是 UI 设计搭子，只出 HTML。',
        },
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const messages = [
      msg({ id: 'u1', role: 'user', content: '请帮我创建一个叫小程序的好友，定位待选' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '可选定位：开发 / 审核合规 / 运营增长？',
      }),
      msg({ id: 'u2', role: 'user', content: '再创建一个 UI 设计好友' }),
      msg({ id: 'a2', role: 'assistant', content: LONG_ASSISTANT }),
    ]
    const content = summarizeMessages(messages, { proposals })
    assert.match(content, /^事件/m)
    assert.match(content, /待用户确认才落库/)
    assert.match(content, /5b0e87af/)
    assert.match(content, /UI 设计/)
    assert.doesNotMatch(content, new RegExp(LONG_MARKER))
    assert.ok(!content.includes(LONG_ASSISTANT.slice(0, 80)))
    assert.ok(countSummaryChars(content) <= SUMMARY_HARD_CAP_CHARS)
  })

  it('确认后写「已保存」，未确认写待确认语义', () => {
    const pending: Proposal = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      conversationId: 'c1',
      kind: 'friend',
      name: '小程序',
      summary: '小程序',
      draft: {},
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    }
    const confirmed: Proposal = {
      ...pending,
      id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'UI 设计搭子',
      status: 'confirmed',
      draft: { description: '纯 HTML 稿' },
    }
    const pendingText = summarizeMessages([], { proposals: [pending] })
    const confirmedText = summarizeMessages([], { proposals: [confirmed] })
    assert.match(pendingText, /待用户确认才落库/)
    assert.doesNotMatch(pendingText, /已保存/)
    assert.match(confirmedText, /已保存/)
    assert.doesNotMatch(confirmedText, /待用户确认才落库/)
  })

  it('硬顶：多事件超出时合并旧事件，长度不随原文线性涨', () => {
    const events: SummaryEvent[] = []
    for (let i = 0; i < 40; i += 1) {
      events.push({
        key: `user:m${i}`,
        text: `用户请求：这是第 ${i} 轮很长的背景说明 ${'背景'.repeat(30)}`,
      })
    }
    const capped = applySummaryHardCap(events, 1000)
    const rendered = ['事件', ...capped.map((e) => `- ${e.text}`), '后续提问会带上此摘要，不必重复背景。'].join('\n')
    assert.ok(countSummaryChars(rendered) <= 1000)
    assert.ok(capped.length < events.length)

    const messages = Array.from({ length: 30 }, (_, i) =>
      msg({
        id: `u${i}`,
        role: 'user',
        content: `轮次${i} ` + '详述'.repeat(200) + LONG_MARKER,
      }),
    )
    const content = summarizeMessages(messages, { hardCap: 1000 })
    assert.ok(countSummaryChars(content) <= 1000)
    assert.doesNotMatch(content, new RegExp(LONG_MARKER))
  })

  it('增量改写：同提案键从待确认变为已保存，不拼接全量原文', () => {
    const id = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const previous = summarizeMessages([], {
      proposals: [
        {
          id,
          conversationId: 'c1',
          kind: 'friend',
          name: 'UI 设计',
          summary: 'x',
          draft: {},
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    assert.match(previous, /待用户确认才落库/)
    const next = summarizeMessages([msg({ id: 'u9', role: 'user', content: '确认了，继续聊别的短句' })], {
      previousContent: previous,
      proposals: [
        {
          id,
          conversationId: 'c1',
          kind: 'friend',
          name: 'UI 设计搭子',
          summary: 'x',
          draft: { description: '纯 HTML' },
          status: 'confirmed',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    assert.match(next, /已保存/)
    assert.doesNotMatch(next, /待用户确认才落库/)
    assert.equal((next.match(/确认卡/g) ?? []).length, 0)
  })

  it('注入路径使用事件摘要，系统消息不含超长原文标记', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-p113-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const proposals = createProposalService(database)
    const seen: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 5,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: string }[] }
        seen.push(
          (body.messages ?? [])
            .filter((item) => item.role === 'system')
            .map((item) => item.content)
            .join('\n'),
        )
        return sse('短回复')
      },
    })
    const conversation = await createConversation(repos, '事件摘要')
    await repos.messages.put({
      id: 'seed-a',
      conversationId: conversation.id,
      role: 'assistant',
      content: LONG_ASSISTANT,
      status: 'complete',
      createdAt: Date.now() - 10,
    })
    await proposals.stage({
      conversationId: conversation.id,
      kind: 'friend',
      name: 'UI 设计',
      summary: '纯 HTML',
      draft: { description: '纯 HTML、不接第三方' },
    })
    const summary = await writeSummary(repos, conversation.id, 'manual', true)
    assert.ok(summary)
    assert.doesNotMatch(summary!.content, new RegExp(LONG_MARKER))
    assert.match(summary!.content, /待用户确认才落库|事件/)

    const turn = await orchestrator.sendTurn({
      conversationId: conversation.id,
      text: '接着说',
      model: 'qwen',
    })
    await waitFor(async () => (await repos.runs.get(turn.run.id))?.status === 'done')
    const injected = seen.at(-1) ?? ''
    assert.match(injected, /已写入记忆的摘要/)
    assert.match(injected, /事件|待用户确认|UI 设计/)
    assert.doesNotMatch(injected, new RegExp(LONG_MARKER))
    orchestrator.dispose()
  })
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
  while (Date.now() - started < 4000) {
    if (await check()) return
    await wait(15)
  }
  throw new Error('等待超时')
}
