import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import {
  cancelSkillExtract,
  confirmSkillExtract,
  DEFAULT_SKILL_EXTRACT_PROMPT,
  listFriendSessionsForSkill,
  normalizeSkillExtractPrompt,
  parseSkillDraftFromMarkdown,
  startSkillExtract,
} from '../src/app/skill-extract.ts'
import { listAttachedSkills } from '../src/app/skills.ts'
import { getAppSettings, updateAppSettings } from '../src/app/settings.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('p1.3 会话抽技能', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  async function setup() {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-p13-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list())[0]!
    const friend = {
      ...owner,
      id: 'friend-pm',
      name: '产品经理',
      isOwnerTemplate: false,
      systemPrompt: '你是产品经理，输出短清单。',
    }
    await repos.friends.put(friend)
    const conversation = await createConversation(repos, '当前会话', {
      kind: 'direct',
      friendIds: [friend.id],
    })
    return { database, repos, friend, conversation, owner }
  }

  it('默认抽技能提示含名称/步骤/边界；空串回默认', () => {
    assert.match(DEFAULT_SKILL_EXTRACT_PROMPT, /技能名称/)
    assert.match(DEFAULT_SKILL_EXTRACT_PROMPT, /适用场景/)
    assert.match(DEFAULT_SKILL_EXTRACT_PROMPT, /注意边界/)
    assert.match(DEFAULT_SKILL_EXTRACT_PROMPT, /不要硬编/)
    assert.equal(normalizeSkillExtractPrompt(''), DEFAULT_SKILL_EXTRACT_PROMPT)
    assert.equal(normalizeSkillExtractPrompt('  '), DEFAULT_SKILL_EXTRACT_PROMPT)
    assert.equal(normalizeSkillExtractPrompt('自定义抽技能'), '自定义抽技能')
  })

  it('设置可读写 skillExtractPrompt，空白恢复默认', async () => {
    const { database } = await setup()
    const initial = await getAppSettings(database)
    assert.equal(initial.skillExtractPrompt, DEFAULT_SKILL_EXTRACT_PROMPT)
    const updated = await updateAppSettings(database, {
      skillExtractPrompt: '自定义：抽通用技能，勿落库前执行。',
    })
    assert.match(updated.skillExtractPrompt, /自定义：抽通用技能/)
    assert.equal((await getAppSettings(database)).skillExtractPrompt, updated.skillExtractPrompt)
    const reset = await updateAppSettings(database, { skillExtractPrompt: '   ' })
    assert.equal(reset.skillExtractPrompt, DEFAULT_SKILL_EXTRACT_PROMPT)
  })

  it('好友 systemPrompt 可读写；空表示未设置', async () => {
    const { repos, friend } = await setup()
    await repos.friends.put({ ...friend, systemPrompt: '人设：产品经理，输出短清单。' })
    assert.match((await repos.friends.get(friend.id))!.systemPrompt, /产品经理/)
    await repos.friends.put({ ...friend, systemPrompt: '' })
    assert.equal((await repos.friends.get(friend.id))!.systemPrompt, '')
  })

  it('无会话可选时列表为空；有会话时当前置顶', async () => {
    const { repos, friend, conversation, owner } = await setup()
    const emptyFriend = {
      ...owner,
      id: 'friend-empty',
      name: '空会话好友',
      isOwnerTemplate: false,
      systemPrompt: '',
    }
    await repos.friends.put(emptyFriend)
    const emptyList = await listFriendSessionsForSkill(repos, emptyFriend.id)
    assert.equal(emptyList.length, 0)

    const other = await createConversation(repos, '旧会话', {
      kind: 'direct',
      friendIds: [friend.id],
    })
    await repos.conversations.put({ ...other, updatedAt: Date.now() - 10_000 })
    const picks = await listFriendSessionsForSkill(repos, friend.id, conversation.id)
    assert.ok(picks.length >= 2)
    assert.equal(picks[0]!.id, conversation.id)
    assert.equal(picks[0]!.isCurrent, true)
  })

  it('解析 Markdown 草案得到名称与步骤', () => {
    const parsed = parseSkillDraftFromMarkdown(`# 验收三步

适用场景：交付前对照方案与截图。

步骤：
1. 对照方案清单
2. 抽确认卡
3. 交包截图

输入与产出：方案 + zip
注意边界：不改 p0.4
`)
    assert.equal(parsed.name, '验收三步')
    assert.match(parsed.scenario, /对照方案/)
    assert.deepEqual(parsed.steps.slice(0, 3), ['对照方案清单', '抽确认卡', '交包截图'])
  })

  it('未确认不落库；确认后挂到好友；取消不写 skills', async () => {
    const { repos, friend, conversation } = await setup()
    await repos.messages.put({
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: '请按三步验收：对照方案、确认卡、交包。',
      status: 'complete',
      createdAt: Date.now(),
    })

    const mockMarkdown = `技能名称：验收三步
适用场景：交付前验收。
步骤：
1. 对照方案
2. 确认卡
3. 交包
`

    const started = await startSkillExtract(repos, {
      targetConversationId: conversation.id,
      friendId: friend.id,
      sourceConversationIds: [conversation.id],
      chatFn: async () => mockMarkdown,
    })
    assert.equal(started.draft.status, 'pending')
    assert.equal((await listAttachedSkills(repos, friend.id)).length, 0)

    const cancelled = await cancelSkillExtract(repos, started.draft.id)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal((await listAttachedSkills(repos, friend.id)).length, 0)

    const again = await startSkillExtract(repos, {
      targetConversationId: conversation.id,
      friendId: friend.id,
      sourceConversationIds: [conversation.id],
      chatFn: async () => mockMarkdown,
    })
    const confirmed = await confirmSkillExtract(repos, again.draft.id, { name: '验收三步·定稿' })
    assert.equal(confirmed.draft.status, 'confirmed')
    assert.equal(confirmed.skill.name, '验收三步·定稿')
    const attached = await listAttachedSkills(repos, friend.id)
    assert.ok(attached.some((item) => item.id === confirmed.skill.id))
  })

  it('未选会话不可开始；跨好友会话拒绝', async () => {
    const { repos, friend, conversation, owner } = await setup()
    await assert.rejects(
      () =>
        startSkillExtract(repos, {
          targetConversationId: conversation.id,
          friendId: friend.id,
          sourceConversationIds: [],
          chatFn: async () => 'x',
        }),
      /至少选择一个会话/,
    )

    const other = {
      ...owner,
      id: 'friend-other',
      name: '另一位',
      isOwnerTemplate: false,
      systemPrompt: '',
    }
    await repos.friends.put(other)
    const foreign = await createConversation(repos, '别人的会话', {
      kind: 'direct',
      friendIds: [other.id],
    })
    await assert.rejects(
      () =>
        startSkillExtract(repos, {
          targetConversationId: conversation.id,
          friendId: friend.id,
          sourceConversationIds: [foreign.id],
          chatFn: async () => 'x',
        }),
      /只能选择当前好友/,
    )
  })
})
