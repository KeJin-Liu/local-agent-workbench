import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import {
  createLongTermMemory,
  formatLongTermMemorySystemPrompt,
  listInjectableForConversation,
  setLtmInjectPref,
  updateLongTermMemory,
} from '../src/app/long-term-memory.ts'
import { listAttachedSkills } from '../src/app/skills.ts'
import {
  acceptSkillSuggestion,
  detectSkillSuggestion,
  dismissSkillSuggestion,
  fingerprintPattern,
} from '../src/app/skill-suggestions.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()

describe('p0.4 长期记忆与建议技能', () => {
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

  it('好友长期记忆可读写，并注入后续回合；与摘要系统消息分开', async () => {
    const repos = await boot()
    const owner = (await repos.friends.list())[0]!
    const memory = await createLongTermMemory(repos, {
      scope: 'friend',
      ownerId: owner.id,
      fact: '输出要短、可执行',
      source: 'manual',
    })
    assert.equal(memory.injectEnabled, true)
    assert.match(memory.fact, /输出要短/)

    const seen: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 10,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: string }[] }
        seen.push((body.messages ?? []).filter((item) => item.role === 'system').map((item) => item.content).join('\n---\n'))
        return sse('好的')
      },
    })
    const conversation = await createConversation(repos, '记忆', { friendIds: [owner.id] })
    const turn = await orchestrator.sendTurn({ conversationId: conversation.id, text: '你好', model: 'qwen' })
    await waitFor(async () => (await repos.runs.get(turn.run.id))?.status === 'done')
    await waitFor(async () => (seen.at(-1) ?? '').includes('长期记忆'))
    assert.match(seen.at(-1) ?? '', /长期记忆/)
    assert.match(seen.at(-1) ?? '', /输出要短/)
    assert.match(formatLongTermMemorySystemPrompt([memory]), /好友/)
    orchestrator.dispose()
  })

  it('项目/群长期记忆可写；停注入后不再进入系统消息', async () => {
    const repos = await boot()
    const owner = (await repos.friends.list())[0]!
    await repos.friends.put({ ...owner, id: 'friend-dev', name: '技术开发', isOwnerTemplate: false })
    const group = await createConversation(repos, 'web智能体的开发', {
      kind: 'group',
      friendIds: [owner.id, 'friend-dev'],
    })
    const ownerId = group.lineageId || group.id
    const memory = await createLongTermMemory(repos, {
      scope: 'project',
      ownerId,
      fact: 'QQ 三栏壳 + Apple HIG',
    })
    let injectable = await listInjectableForConversation(repos, group)
    assert.equal(injectable.projectCount, 1)
    await updateLongTermMemory(repos, memory.id, { injectEnabled: false })
    injectable = await listInjectableForConversation(repos, group)
    assert.equal(injectable.projectCount, 0)
    await updateLongTermMemory(repos, memory.id, { injectEnabled: true })
    await setLtmInjectPref(repos, 'project', ownerId, false)
    injectable = await listInjectableForConversation(repos, group)
    assert.equal(injectable.projectCount, 0)
  })

  it('重复模式出示建议；忽略不写 skills；确认后出现在好友已挂技能', async () => {
    const repos = await boot()
    const owner = (await repos.friends.list())[0]!
    const conversation = await createConversation(repos, '建议', { friendIds: [owner.id] })
    const phrase = '验收三步：对照方案 / 抽确认卡 / 交包截图'
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) {
      await repos.messages.put({
        id: `u-${i}`,
        conversationId: conversation.id,
        role: 'user',
        content: phrase,
        status: 'complete',
        createdAt: now - (2 - i) * 60_000,
      })
    }
    assert.equal(fingerprintPattern(phrase), fingerprintPattern('验收三步：对照方案 / 抽确认卡 / 交包截图。'))
    const suggestion = await detectSkillSuggestion(repos, conversation.id)
    assert.ok(suggestion)
    assert.equal(suggestion?.status, 'pending')
    assert.equal(suggestion?.occurrenceCount, 3)
    assert.equal((await listAttachedSkills(repos, owner.id)).length, 0)

    await dismissSkillSuggestion(repos, suggestion!.id)
    assert.equal((await listAttachedSkills(repos, owner.id)).length, 0)
    const dismissed = await repos.skillSuggestions.get(suggestion!.id)
    assert.equal(dismissed?.status, 'dismissed')

    // 再造一张 pending 卡并确认
    for (let i = 3; i < 6; i += 1) {
      await repos.messages.put({
        id: `u-${i}`,
        conversationId: conversation.id,
        role: 'user',
        content: '日报三步：收集进度 / 标风险 / 发群',
        status: 'complete',
        createdAt: now - (5 - i) * 60_000,
      })
    }
    const again = await detectSkillSuggestion(repos, conversation.id)
    assert.ok(again)
    const skillsBefore = (await repos.skills.list()).length
    const { skill } = await acceptSkillSuggestion(repos, again!.id, {
      scope: 'friends',
      friendIds: [owner.id],
      name: '日报三步清单',
    })
    assert.equal((await repos.skills.list()).length, skillsBefore + 1)
    assert.equal(skill.scope, 'friends')
    assert.deepEqual(skill.friendIds, [owner.id])
    assert.equal((await listAttachedSkills(repos, owner.id))[0]?.name, '日报三步清单')
  })

  it('近 7 天窗口外的重复不计次', async () => {
    const repos = await boot()
    const owner = (await repos.friends.list())[0]!
    const conversation = await createConversation(repos, '过期', { friendIds: [owner.id] })
    const phrase = '周报四步：收集 / 归纳 / 风险 / 发出'
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000
    for (let i = 0; i < 3; i += 1) {
      await repos.messages.put({
        id: `old-${i}`,
        conversationId: conversation.id,
        role: 'user',
        content: phrase,
        status: 'complete',
        createdAt: stale + i,
      })
    }
    assert.equal(await detectSkillSuggestion(repos, conversation.id), null)
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) {
      await repos.messages.put({
        id: `new-${i}`,
        conversationId: conversation.id,
        role: 'user',
        content: phrase,
        status: 'complete',
        createdAt: now - i * 1000,
      })
    }
    const suggestion = await detectSkillSuggestion(repos, conversation.id)
    assert.ok(suggestion)
    assert.equal(suggestion?.occurrenceCount, 3)
  })

    async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-p04-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    return createRepos(database)
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
