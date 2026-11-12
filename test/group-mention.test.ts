/**
 * 群聊 @ 路由：不 @ 由群主接；@ 某位好友就由 TA 直接回，群主不介入。
 * 群主在回复里 @ 群友时，通过 onGroupHandoff 把活交出去（生产里会创建指派）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import type { Friend, Run } from '../src/domain/types.ts'
import { createConversation, updateGroupConversation } from '../src/app/conversations.ts'
import { createLongTermMemory } from '../src/app/long-term-memory.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()
const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('群聊 @ 好友路由', () => {
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
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
  })

  it('不 @ 默认群主；@ 好友时由 TA 用自己的模型直接回，会话模型不被改写', async () => {
    const { repos, owner, dev, group } = await bootGroup()
    const seen: Array<{ system: string; user: string }> = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>
        }
        const system = body.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
        const user = body.messages.filter((item) => item.role === 'user').at(-1)?.content ?? ''
        seen.push({ system, user })
        return sse('收到')
      },
    })

    const ownerTurn = await turns.sendTurn({ conversationId: group.id, text: '帮我看下这个需求怎么拆', delayMs: 0 })
    await waitDone(repos, ownerTurn.run.id)
    const first = seen.at(-1)
    assert.doesNotMatch(first?.system ?? '', /你是本地工作台里的群主/)
    assert.match(first?.system ?? '', /用户没有 @ 人时由你（群主）接话/)
    assert.match(first?.system ?? '', /@代码开发/)
    assert.equal(ownerTurn.run.speakerFriendId, owner.id)

    const direct = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 先看下路由', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    const second = seen.at(-1)
    assert.doesNotMatch(second?.system ?? '', /你是代码开发/)
    assert.match(second?.system ?? '', /用户点名 @代码开发/)
    assert.doesNotMatch(second?.system ?? '', /用户没有 @ 人时由你（群主）接话/)
    assert.equal(direct.run.speakerFriendId, dev.id)
    assert.equal(direct.run.model, 'dev-model')

    const messages = await repos.messages.listByConversation(group.id)
    const assistant = messages.find((item) => item.role === 'assistant' && item.runId === direct.run.id)
    assert.equal(assistant?.speakerFriendId, dev.id)
    const conversation = await repos.conversations.get(group.id)
    assert.equal(conversation?.model, 'dev-model')
    assert.equal(ownerTurn.run.model, 'owner-model')

    turns.dispose()
  })

  it('本群指定的模型只用于这次发言，不改好友自己的模型', async () => {
    const { repos, dev, group } = await bootGroup()
    await repos.conversations.put({
      ...group,
      memberModels: {
        [dev.id]: { providerId: group.providerId, model: 'group-only-model' },
      },
    })
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse('收到'),
    })
    const direct = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 看下接口', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    assert.equal(direct.run.model, 'group-only-model')
    const ownerTurn = await turns.sendTurn({ conversationId: group.id, text: '群主继续', delayMs: 0 })
    await waitDone(repos, ownerTurn.run.id)
    assert.equal(ownerTurn.run.model, 'owner-model')
    const friends = await repos.friends.list()
    assert.equal(friends.find((item) => item.id === dev.id)?.defaultModelId, 'dev-model')
    turns.dispose()
  })

  it('群里没保存提示词就不注入好友人设；保存后只注入本群那条', async () => {
    const { repos, owner, dev, group } = await bootGroup()
    const seen: string[] = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        seen.push(body.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n'))
        return sse('收到')
      },
    })
    const plain = await turns.sendTurn({ conversationId: group.id, text: '先看一下', delayMs: 0 })
    await waitDone(repos, plain.run.id)
    assert.doesNotMatch(seen.at(-1) ?? '', /你是本地工作台里的群主/)

    await repos.conversations.put({
      ...(await repos.conversations.get(group.id))!,
      memberPrompts: { [owner.id]: '本群群主只谈彩票走势。', [dev.id]: '本群代码只改走势图。' },
    })
    const withPrompt = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 改图', delayMs: 0 })
    await waitDone(repos, withPrompt.run.id)
    const prompted = seen.at(-1) ?? ''
    assert.match(prompted, /本群代码只改走势图/)
    assert.doesNotMatch(prompted, /你是代码开发/)
    assert.doesNotMatch(prompted, /本群群主只谈彩票走势/)
    const directChat = await createConversation(repos, '和开发单聊', { friendIds: [dev.id] })
    const direct = await turns.sendTurn({ conversationId: directChat.id, text: '你好', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    assert.match(seen.at(-1) ?? '', /你是代码开发/)
    assert.doesNotMatch(seen.at(-1) ?? '', /本群代码只改走势图/)
    turns.dispose()
  })

  it('群主回复里 @ 群友会触发交办；点名好友的回合不会再触发', async () => {
    const { repos, owner, dev, group } = await bootGroup()
    const handoffs: Array<{ toFriendId: string; instruction: string; fromFriendId: string }> = []
    let reply = '先拆一下：@代码开发 请把 @ 路由接到群聊。'
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      onGroupHandoff: async (input) => {
        handoffs.push({ toFriendId: input.toFriendId, instruction: input.instruction, fromFriendId: input.fromFriendId })
      },
      fetchImpl: async () => sse(reply),
    })

    const ownerTurn = await turns.sendTurn({ conversationId: group.id, text: '怎么拆', delayMs: 0 })
    await waitDone(repos, ownerTurn.run.id)
    assert.equal(handoffs.length, 1)
    assert.equal(handoffs[0]?.fromFriendId, owner.id)
    assert.equal(handoffs[0]?.toFriendId, dev.id)
    assert.match(handoffs[0]?.instruction ?? '', /^请把 @ 路由接到群聊。$/)

    // 用户直接 @ 好友：发送者不再是群主，不应再产生交办
    reply = '收到，@UI 设计师 你那边也看下。'
    const direct = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 你直接做', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    assert.equal(handoffs.length, 1)

    turns.dispose()
  })

  it('群里只有群主带上一段记忆；被点名的成员只看当前这条', async () => {
    const { repos, owner, group } = await bootGroup()
    const now = Date.now()
    await repos.messages.put({
      id: 'prior-user',
      conversationId: group.id,
      role: 'user',
      content: '昨天约定接口用 REST',
      status: 'complete',
      createdAt: now - 2000,
    })
    await repos.messages.put({
      id: 'prior-assistant',
      conversationId: group.id,
      role: 'assistant',
      speakerFriendId: owner.id,
      content: '群主记下：先按 REST 拆',
      status: 'complete',
      createdAt: now - 1000,
    })
    await repos.summaries.put({
      id: 'sum-group',
      conversationId: group.id,
      content: '会话摘要标记-群接口',
      injectOnNextTurn: true,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    })
    await createLongTermMemory(repos, {
      scope: 'project',
      ownerId: group.lineageId || group.id,
      fact: '项目长期记忆标记-用 pnpm',
    })

    const seen: string[] = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        seen.push(body.messages.map((item) => item.content).join('\n'))
        return sse('收到')
      },
    })

    const ownerTurn = await turns.sendTurn({ conversationId: group.id, text: '继续拆这个需求', delayMs: 0 })
    await waitDone(repos, ownerTurn.run.id)
    const ownerPrompt = seen.at(-1) ?? ''
    assert.match(ownerPrompt, /昨天约定接口用 REST/)
    assert.match(ownerPrompt, /群主记下：先按 REST 拆/)
    assert.match(ownerPrompt, /会话摘要标记-群接口/)
    assert.match(ownerPrompt, /项目长期记忆标记-用 pnpm/)
    assert.match(ownerPrompt, /其他成员看不到更早的对话和记忆/)

    const direct = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 只改路由文件', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    const memberPrompt = seen.at(-1) ?? ''
    assert.match(memberPrompt, /只改路由文件/)
    assert.match(memberPrompt, /你没有本群之前的对话、摘要或长期记忆/)
    assert.doesNotMatch(memberPrompt, /昨天约定接口用 REST/)
    assert.doesNotMatch(memberPrompt, /群主记下：先按 REST 拆/)
    assert.doesNotMatch(memberPrompt, /会话摘要标记-群接口/)
    assert.doesNotMatch(memberPrompt, /项目长期记忆标记-用 pnpm/)
    assert.doesNotMatch(memberPrompt, /继续拆这个需求/)

    const messages = await repos.messages.listByConversation(group.id)
    const ownerReply = messages.find((item) => item.role === 'assistant' && item.runId === ownerTurn.run.id)
    const memberReply = messages.find((item) => item.role === 'assistant' && item.runId === direct.run.id)
    assert.equal(ownerReply?.memoryInject?.summary, true)
    assert.ok((ownerReply?.memoryInject?.ltmProjectCount ?? 0) >= 1)
    assert.equal(memberReply?.memoryInject, undefined)

    turns.dispose()
  })

  it('调用模型时写明当前发言人和每位成员自己的工作目录', async () => {
    const { repos, group } = await bootGroup()
    const root = path.join(directory, 'group-root')
    await updateGroupConversation(repos, group.id, {
      title: group.title,
      friendIds: group.friendIds,
      workspaceRoot: root,
    })
    const ownerDir = path.join(path.resolve(root), group.title, '群主')
    const devDir = path.join(path.resolve(root), group.title, '代码开发')
    const seen: string[] = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        seen.push(body.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n'))
        return sse('收到')
      },
    })

    const ownerTurn = await turns.sendTurn({ conversationId: group.id, text: '出一版界面稿', delayMs: 0 })
    await waitDone(repos, ownerTurn.run.id)
    const ownerPrompt = seen.at(-1) ?? ''
    assert.ok(ownerPrompt.includes(`你的工作目录是 ${ownerDir}`))
    assert.ok(ownerPrompt.includes(`工作目录 ${devDir}`))
    assert.match(ownerPrompt, /不要把自己的目录交给对方/)
    assert.equal(ownerPrompt.includes(`你的工作目录是 ${devDir}`), false)

    const direct = await turns.sendTurn({ conversationId: group.id, text: '@代码开发 把稿写到你的工作目录', delayMs: 0 })
    await waitDone(repos, direct.run.id)
    const memberPrompt = seen.at(-1) ?? ''
    assert.ok(memberPrompt.includes(`你的工作目录是 ${devDir}`))
    assert.equal(memberPrompt.includes(`你的工作目录是 ${ownerDir}`), false)
    turns.dispose()
  })

  it('和好友单聊仍注入摘要、长期记忆和更早的对话', async () => {
    const { repos, dev } = await bootGroup()
    const now = Date.now()
    const chat = await createConversation(repos, '和开发单聊', { friendIds: [dev.id] })
    await repos.messages.put({
      id: 'direct-prior',
      conversationId: chat.id,
      role: 'user',
      content: '单聊里记得用 vitest',
      status: 'complete',
      createdAt: now - 1000,
    })
    await repos.summaries.put({
      id: 'sum-direct',
      conversationId: chat.id,
      content: '单聊摘要标记-vitest',
      injectOnNextTurn: true,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    })
    await createLongTermMemory(repos, {
      scope: 'friend',
      ownerId: dev.id,
      fact: '单聊长期记忆标记-喜欢短回复',
    })

    let prompt = ''
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        prompt = body.messages.map((item) => item.content).join('\n')
        return sse('收到')
      },
    })
    const turn = await turns.sendTurn({ conversationId: chat.id, text: '接着写测试', delayMs: 0 })
    await waitDone(repos, turn.run.id)
    assert.match(prompt, /单聊里记得用 vitest/)
    assert.match(prompt, /单聊摘要标记-vitest/)
    assert.match(prompt, /单聊长期记忆标记-喜欢短回复/)
    assert.match(prompt, /接着写测试/)
    turns.dispose()
  })

  it('输入框接线：@ 菜单、点名提示、不把群主模型带给被点名好友', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /className="mention-menu"/)
    assert.match(pane, /syncMentionMenu/)
    assert.match(pane, /mentionToOther/)
    assert.match(pane, /已点名 @/)
    assert.match(pane, /mentionCaretRef/)
    assert.match(pane, /用 @ 直接找群友（不带之前的记忆）· 不 @ 由群主接/)

    const app = await readFile(path.join(root, 'src/ui/App.tsx'), 'utf8')
    assert.match(app, /friend\.isOwnerTemplate/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.mention-menu/)
    assert.match(css, /\.mention-item\.is-active/)
  })

  async function bootGroup() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-mention-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const seededOwner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(seededOwner)
    const owner: Friend = { ...seededOwner, defaultModelId: 'owner-model', systemPrompt: '你是本地工作台里的群主。' }
    await repos.friends.put(owner)
    const dev: Friend = {
      ...owner,
      id: 'friend-dev',
      name: '代码开发',
      isOwnerTemplate: false,
      defaultModelId: 'dev-model',
      systemPrompt: '你是代码开发。',
      workspacePath: '/tmp/dev-workspace',
      codePermission: 'read-only',
    }
    const ui: Friend = {
      ...owner,
      id: 'friend-ui',
      name: 'UI 设计师',
      isOwnerTemplate: false,
      defaultModelId: 'ui-model',
      systemPrompt: '你是 UI 设计师。',
      workspacePath: '',
    }
    await repos.friends.put(dev)
    await repos.friends.put(ui)
    // 故意把代码开发放第一位：不 @ 时仍应由群主接，而不是好友列表第一位。
    const group = await createConversation(repos, '开发群', {
      kind: 'group',
      friendIds: [dev.id, owner.id, ui.id],
    })
    return { repos, owner, dev, ui, group }
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

async function waitDone(repos: ReturnType<typeof createRepos>, runId: string) {
  await waitFor(async () => {
    const run: Run | undefined = await repos.runs.get(runId)
    return Boolean(run && (run.status === 'done' || run.status === 'error' || run.status === 'cancelled'))
  })
  const run = await repos.runs.get(runId)
  assert.equal(run?.status, 'done', run?.error)
}

async function waitFor(check: () => Promise<boolean> | boolean) {
  const started = Date.now()
  while (Date.now() - started < 3000) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('等待超时')
}
