/**
 * p0.8.1：气泡 Markdown；Friend.defaultModelId；propose kind=friend 确认门闩
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createProposalService } from '../src/app/proposals.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { markdownPlainText, parseMarkdown } from '../src/ui/markdown-core.ts'

describe('p0.8.1 Markdown / defaultModelId / propose friend', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('Markdown 把 **粗体** 收成 strong，不留生星号', () => {
    const source = '请看 **粗体** 与 `code`'
    const blocks = parseMarkdown(source)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'p')
    const children = blocks[0]!.type === 'p' ? blocks[0]!.children : []
    assert.ok(children.some((node) => node.type === 'strong'))
    assert.ok(children.some((node) => node.type === 'code' && node.value === 'code'))
    const plain = markdownPlainText(source)
    assert.equal(plain, '请看 粗体 与 code')
    assert.doesNotMatch(plain, /\*\*/)
  })

  it('Friend.defaultModelId 可持久化；再次读取仍是上次选择', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friend = ctx.friends[0]!
    await ctx.repos.friends.put({
      ...friend,
      defaultModelId: 'qwen2.5:7b',
      updatedAt: Date.now(),
    })
    const again = await ctx.repos.friends.get(friend.id)
    assert.equal(again?.defaultModelId, 'qwen2.5:7b')
  })

  it('kind=friend：未确认不落库；确认写入好友与可选默认模型；取消丢草稿', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const before = (await ctx.database.read()).stores.friends.length
    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend',
      name: 'UI设计助手',
      summary: '出 HTML 稿',
      draft: {
        systemPrompt: '你是 UI 设计，交付可交互 HTML。',
        description: '视觉跟 Apple HIG',
        defaultModelId: 'deepseek-chat',
      },
    })
    assert.equal((await ctx.database.read()).stores.friends.length, before)
    assert.equal((await ctx.proposals.listPending('c1')).length, 1)

    await ctx.proposals.confirm(pending.id, 'global', [], {
      name: 'UI设计',
      systemPrompt: '你是 UI 设计，交付可交互 HTML。',
      description: '视觉跟 Apple HIG',
      defaultModelId: 'deepseek-chat',
    })
    const doc = await ctx.database.read()
    assert.equal(doc.stores.friends.length, before + 1)
    const created = doc.stores.friends.find((item) => item.name === 'UI设计')
    assert.ok(created)
    assert.match(created!.systemPrompt, /可交互 HTML/)
    assert.equal(created!.defaultModelId, 'deepseek-chat')
    assert.equal((await ctx.proposals.listPending('c1')).length, 0)

    const draft = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend',
      name: '临时好友',
      draft: { systemPrompt: 'x' },
    })
    await ctx.proposals.cancel(draft.id)
    assert.equal((await ctx.database.read()).stores.friends.length, before + 1)
  })

  it('kind=friend 确认前改名人设；同名拒绝且不落库；空名不可确认', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const owner = ctx.friends[0]!
    const before = (await ctx.database.read()).stores.friends.length
    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend',
      name: '草稿名',
      draft: { systemPrompt: '旧人设' },
    })
    await assert.rejects(
      () => ctx.proposals.confirm(pending.id, 'global', [], { name: owner.name, systemPrompt: '撞名' }),
      /同名好友/,
    )
    assert.equal((await ctx.database.read()).stores.friends.length, before)
    const still = (await ctx.database.read()).stores.proposals.find((item) => item.id === pending.id)
    assert.equal(still?.status, 'pending')
    assert.ok(still?.error)

    const blank = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend',
      name: '待清空',
      draft: {},
    })
    await assert.rejects(
      () => ctx.proposals.confirm(blank.id, 'global', [], { name: '   ' }),
      /好友名称不能为空/,
    )
    assert.equal((await ctx.database.read()).stores.friends.length, before)
  })
})

async function boot() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-p081-'))
  const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
  await seedIfEmpty(database)
  const repos = createRepos(database)
  const proposals = createProposalService(database)
  const friends = await repos.friends.list()
  return { directory, database, repos, proposals, friends }
}
