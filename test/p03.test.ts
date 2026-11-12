import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createAssignmentService } from '../src/app/assignments.ts'
import { createConversation } from '../src/app/conversations.ts'
import { listAttachedSkills, saveSkillForFriend } from '../src/app/skills.ts'
import { injectSummary, summarizeMessages, writeSummary } from '../src/memory/commit.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()

describe('p0.3 摘要、指派、技能', () => {
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

  it('完成后写入摘要，下一回合把摘要注入系统消息', async () => {
    const repos = await boot()
    const seen: string[] = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 10,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string; content: string }[] }
        seen.push((body.messages ?? []).filter((item) => item.role === 'system').map((item) => item.content).join('\n'))
        return sse('记下了')
      },
    })
    const conversation = await createConversation(repos, '摘要')
    const first = await orchestrator.sendTurn({ conversationId: conversation.id, text: '背景是验收三条', model: 'qwen' })
    await waitFor(async () => {
      const run = await repos.runs.get(first.run.id)
      if (run?.status !== 'done') return false
      const summary = await repos.summaries.latest(conversation.id)
      return Boolean(summary?.injectOnNextTurn)
    })
    const summary = await repos.summaries.latest(conversation.id)
    assert.equal(summary?.injectOnNextTurn, true)
    assert.match(summary?.content ?? '', /验收三条/)
    const second = await orchestrator.sendTurn({ conversationId: conversation.id, text: '接着说', model: 'qwen' })
    await waitFor(async () => (await repos.runs.get(second.run.id))?.status === 'done')
    assert.match(seen.at(-1) ?? '', /已写入记忆的摘要/)
    assert.match(seen.at(-1) ?? '', /验收三条/)
    orchestrator.dispose()
  })

  it('手动生成后要再点注入才会进入后续回合', async () => {
    const repos = await boot()
    const conversation = await createConversation(repos, '手动')
    await repos.messages.put({
      id: 'm1',
      conversationId: conversation.id,
      role: 'user',
      content: '先记下边界',
      status: 'complete',
      createdAt: 1,
    })
    const draft = await writeSummary(repos, conversation.id, 'manual', false)
    assert.equal(draft?.injectOnNextTurn, false)
    const kept = await injectSummary(repos, conversation.id)
    assert.equal(kept.injectOnNextTurn, true)
    assert.equal(summarizeMessages([]), '')
  })

  it('群主指派的结果回流同一条群会话，失败不写结果消息', async () => {
    const { database, repos } = await bootWithDatabase()
    const owner = (await repos.friends.list())[0]!
    await repos.friends.put({ ...owner, id: 'friend-dev', name: '技术开发', isOwnerTemplate: false })
    const group = await createConversation(repos, '开发群', { kind: 'group', friendIds: [owner.id, 'friend-dev'] })
    const ok = createAssignmentService(database, async () => '数据层已就绪')
    const assignment = await ok.create(group.id, 'friend-dev', '先把摘要注入接上')
    const done = await ok.settle(assignment.id)
    assert.equal(done.status, 'done')
    assert.ok(done.resultMessageId)
    const messages = (await repos.messages.listByConversation(group.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    assert.deepEqual(messages.map((item) => item.kind), ['assign', 'result'])
    assert.equal(messages[1]?.content, '数据层已就绪')
    assert.equal(messages[1]?.speakerFriendId, 'friend-dev')

    const failing = createAssignmentService(database, async () => {
      throw new Error('提供方超时')
    })
    const again = await failing.create(group.id, 'friend-dev', '再试一次')
    const stuck = await failing.settle(again.id)
    assert.equal(stuck.status, 'pending')
    assert.match(stuck.error ?? '', /超时/)
    const after = await repos.messages.listByConversation(group.id)
    assert.equal(after.filter((item) => item.assignmentId === again.id && item.kind === 'result').length, 0)

    const direct = await createConversation(repos, '单聊')
    await assert.rejects(() => failing.create(direct.id, 'friend-dev', '不行'), /群聊/)
  })

  it('确认前不写技能，确认后出现在好友已挂列表', async () => {
    const repos = await boot()
    const owner = (await repos.friends.list())[0]!
    assert.equal((await listAttachedSkills(repos, owner.id)).length, 0)
    const skill = await saveSkillForFriend(repos, {
      name: '验收三步清单',
      friendId: owner.id,
      steps: ['对照方案', '抽确认卡', '交包截图'],
    })
    assert.deepEqual(skill.friendIds, [owner.id])
    assert.equal(skill.scope, 'friends')
    assert.match(skill.body, /1\. 对照方案/)
    assert.equal((await listAttachedSkills(repos, owner.id))[0]?.name, '验收三步清单')
  })

  async function boot() {
    const { repos } = await bootWithDatabase()
    return repos
  }

  async function bootWithDatabase() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-p03-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    return { database, repos: createRepos(database) }
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
