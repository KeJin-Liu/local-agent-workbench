/**
 * p1.4：对话写入全部配置 — propose 新 kind 门闩与脱敏
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  createProposalService,
  diffAppSettingsSummary,
  maskSecret,
  summarizeConfigForModel,
} from '../src/app/proposals.ts'
import { getAppSettings } from '../src/app/settings.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'
import { createVault } from '../src/vault/service.ts'

describe('p1.4 对话写入配置', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('maskSecret 脱敏末四位', () => {
    assert.equal(maskSecret('sk-abcdefgh'), '••••efgh')
    assert.equal(maskSecret('ab'), '••••')
  })

  it('kind=provider：未确认不落库；确认写提供方+vault；取消丢草稿；Key 不进 draft 明文', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const before = (await ctx.database.read()).stores.providers.length
    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'provider',
      name: 'Custom LLM',
      draft: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-live-secret-xyz9',
        enabled: true,
        defaultModel: 'demo-model',
      },
    })
    assert.equal((await ctx.database.read()).stores.providers.length, before)
    assert.equal(pending.draft.apiKey, undefined)
    assert.equal(pending.draft.apiKeyMasked, '••••xyz9')
    assert.ok(pending.draft.stagedSecret)
    assert.equal(JSON.stringify(pending).includes('sk-live-secret-xyz9'), false)

    const cancelled = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'provider',
      name: 'Temp',
      draft: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-temp-aaaa' },
    })
    await ctx.proposals.cancel(cancelled.id)
    assert.equal((await ctx.database.read()).stores.providers.length, before)

    const saved = await ctx.proposals.confirm(pending.id, 'global')
    assert.equal(saved.status, 'confirmed')
    const doc = await ctx.database.read()
    assert.equal(doc.stores.providers.length, before + 1)
    const created = doc.stores.providers.find((item) => item.name === 'Custom LLM')
    assert.ok(created)
    assert.equal(created!.baseUrl, 'https://api.example.com/v1')
    assert.equal(created!.defaultModel, 'demo-model')
    assert.ok(created!.vaultEntryId)
    assert.equal('apiKey' in created!, false)
    const revealed = await ctx.vault.reveal(created!.vaultEntryId!)
    assert.equal(revealed?.apiKey, 'sk-live-secret-xyz9')
    const raw = await readFile(path.join(directory, 'agent_workbench.json'), 'utf8')
    assert.equal(raw.includes('sk-live-secret-xyz9'), false)
  })

  it('kind=provider 非法 Base URL 人话错误；更新已有不清空 Key', async () => {
    const ctx = await boot()
    directory = ctx.directory
    await assert.rejects(
      () =>
        ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'provider',
          name: '坏地址',
          draft: { baseUrl: 'not-a-url', apiKey: 'sk-x' },
        }),
      /Base URL/,
    )

    const existing = (await ctx.database.read()).stores.providers.find((item) => item.id === 'ollama-local')
    assert.ok(existing)
    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'provider',
      name: existing!.name,
      draft: {
        id: existing!.id,
        name: existing!.name,
        baseUrl: existing!.baseUrl,
        defaultModel: 'qwen2.5:7b',
        enabled: true,
      },
    })
    await ctx.proposals.confirm(pending.id, 'global')
    const again = (await ctx.database.read()).stores.providers.find((item) => item.id === existing!.id)
    assert.equal(again?.defaultModel, 'qwen2.5:7b')
    assert.equal(again?.vaultEntryId, existing?.vaultEntryId)
  })

  it('kind=app_settings：pending→confirm 写入；cancel 不写；非法秒数拒绝', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const before = await getAppSettings(ctx.database)
    assert.notEqual(before.sendWaitSeconds, 3)

    await assert.rejects(
      () =>
        ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'app_settings',
          name: '坏等待',
          draft: { sendWaitSeconds: 99 },
        }),
      /1–10/,
    )
    await assert.rejects(
      () =>
        ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'app_settings',
          name: '空补丁',
          draft: {},
        }),
      /缺少可写入/,
    )

    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'app_settings',
      name: '改等待与邮箱开关',
      draft: {
        sendWaitSeconds: 3,
        planModePrompt: '计划提示测试',
        skillExtractPrompt: '抽技能提示测试',
        mailInstructions: { enabled: true, whitelist: ['boss@example.com'] },
      },
    })
    assert.match(pending.summary, /发送等待/)
    assert.equal((await getAppSettings(ctx.database)).sendWaitSeconds, before.sendWaitSeconds)

    const draft = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'app_settings',
      name: '取消这项',
      draft: { sendWaitSeconds: 8 },
    })
    await ctx.proposals.cancel(draft.id)
    assert.equal((await getAppSettings(ctx.database)).sendWaitSeconds, before.sendWaitSeconds)

    await ctx.proposals.confirm(pending.id, 'global')
    const after = await getAppSettings(ctx.database)
    assert.equal(after.sendWaitSeconds, 3)
    assert.equal(after.planModePrompt, '计划提示测试')
    assert.equal(after.skillExtractPrompt, '抽技能提示测试')
    assert.equal(after.mailInstructions.enabled, true)
    assert.deepEqual(after.mailInstructions.whitelist, ['boss@example.com'])
  })

  it('kind=friend_patch：确认更新；取消不改；缺 friendId / 启停字段人话错误', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friend = (await ctx.database.read()).stores.friends[0]!
    const beforePrompt = friend.systemPrompt

    await assert.rejects(
      () =>
        ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'friend_patch',
          name: '无 id',
          draft: { systemPrompt: 'x' },
        }),
      /friendId/,
    )

    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend_patch',
      name: friend.name,
      draft: {
        friendId: friend.id,
        systemPrompt: '新的系统提示词',
        workspacePath: '/tmp/ws-demo',
        defaultModelId: 'demo-model',
      },
    })
    assert.equal((await ctx.database.read()).stores.friends.find((item) => item.id === friend.id)?.systemPrompt, beforePrompt)

    const bad = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend_patch',
      name: friend.name,
      draft: { friendId: friend.id, systemPrompt: '不应写入', enabled: false },
    })
    await assert.rejects(() => ctx.proposals.confirm(bad.id, 'global'), /启停/)
    assert.equal((await ctx.database.read()).stores.friends.find((item) => item.id === friend.id)?.systemPrompt, beforePrompt)

    await ctx.proposals.cancel(
      (
        await ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'friend_patch',
          name: friend.name,
          draft: { friendId: friend.id, systemPrompt: '取消用' },
        })
      ).id,
    )
    assert.equal((await ctx.database.read()).stores.friends.find((item) => item.id === friend.id)?.systemPrompt, beforePrompt)

    await ctx.proposals.confirm(pending.id, 'global')
    const updated = (await ctx.database.read()).stores.friends.find((item) => item.id === friend.id)!
    assert.equal(updated.systemPrompt, '新的系统提示词')
    assert.equal(updated.workspacePath, '/tmp/ws-demo')
    assert.equal(updated.defaultModelId, 'demo-model')
  })

  it('kind=group：新建群 + 加成员；取消不落库', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const friends = (await ctx.database.read()).stores.friends
    // seed 通常只有群主；再塞一个好友
    await ctx.database.update((doc) => {
      const providerId = doc.stores.providers[0]!.id
      doc.stores.friends.push({
        id: 'friend-b',
        name: '搭档 B',
        description: '',
        systemPrompt: 'B',
        isOwnerTemplate: false,
        avatar: { kind: 'default', id: 'seal', path: '/avatars/defaults/seal.svg' },
        providerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      doc.stores.friends.push({
        id: 'friend-c',
        name: '搭档 C',
        description: '',
        systemPrompt: 'C',
        isOwnerTemplate: false,
        avatar: { kind: 'default', id: 'seal', path: '/avatars/defaults/seal.svg' },
        providerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    })
    const a = friends[0]!.id
    const beforeGroups = (await ctx.database.read()).stores.conversations.filter((item) => item.kind === 'group').length

    await assert.rejects(
      () =>
        ctx.proposals.stage({
          conversationId: 'c1',
          kind: 'group',
          name: '两人不够',
          draft: { action: 'create', friendIds: [a] },
        }),
      /两个好友/,
    )

    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'group',
      name: '产品三人组',
      draft: { action: 'create', title: '产品三人组', friendIds: [a, 'friend-b'] },
    })
    assert.equal(
      (await ctx.database.read()).stores.conversations.filter((item) => item.kind === 'group').length,
      beforeGroups,
    )
    await ctx.proposals.confirm(pending.id, 'global')
    const groups = (await ctx.database.read()).stores.conversations.filter((item) => item.kind === 'group')
    assert.equal(groups.length, beforeGroups + 1)
    const created = groups.find((item) => item.title === '产品三人组')
    assert.ok(created)
    assert.deepEqual(created!.friendIds.sort(), [a, 'friend-b'].sort())

    const add = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'group',
      name: '加人',
      draft: { action: 'add_members', conversationId: created!.id, friendIds: ['friend-c'] },
    })
    await ctx.proposals.confirm(add.id, 'global')
    const again = (await ctx.database.read()).stores.conversations.find((item) => item.id === created!.id)!
    assert.ok(again.friendIds.includes('friend-c'))
    assert.equal(again.friendIds.length, 3)
  })

  it('kind=vault_binding：确认绑提供方；卡面脱敏；取消不写 secrets', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const provider = (await ctx.database.read()).stores.providers.find((item) => item.id === 'deepseek') ||
      (await ctx.database.read()).stores.providers[0]!
    const secretsBefore = (await ctx.database.read()).stores.secrets.length

    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'vault_binding',
      name: 'DeepSeek Key',
      draft: {
        apiKey: 'sk-bind-me-1234',
        bindTarget: 'provider',
        providerId: provider.id,
      },
    })
    assert.equal(pending.draft.apiKey, undefined)
    assert.equal(pending.draft.apiKeyMasked, '••••1234')
    assert.equal((await ctx.database.read()).stores.secrets.length, secretsBefore)

    const cancel = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'vault_binding',
      name: '取消绑定',
      draft: { apiKey: 'sk-cancel-9999', bindTarget: 'provider', providerId: provider.id },
    })
    await ctx.proposals.cancel(cancel.id)
    assert.equal((await ctx.database.read()).stores.secrets.length, secretsBefore)

    await ctx.proposals.confirm(pending.id, 'global')
    const doc = await ctx.database.read()
    assert.equal(doc.stores.secrets.length, secretsBefore + 1)
    const bound = doc.stores.providers.find((item) => item.id === provider.id)!
    assert.ok(bound.vaultEntryId)
    const revealed = await ctx.vault.reveal(bound.vaultEntryId!)
    assert.equal(revealed?.apiKey, 'sk-bind-me-1234')
  })

  it('回归：skill / friend 确认与取消仍可用', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const beforeSkills = (await ctx.database.read()).stores.skills.length
    const beforeFriends = (await ctx.database.read()).stores.friends.length

    const skill = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'skill',
      name: '回归技能',
      draft: { body: '步骤一' },
    })
    await ctx.proposals.confirm(skill.id, 'global')
    assert.equal((await ctx.database.read()).stores.skills.length, beforeSkills + 1)

    const friend = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend',
      name: '回归好友',
      draft: { systemPrompt: '人设' },
    })
    await ctx.proposals.cancel(friend.id)
    assert.equal((await ctx.database.read()).stores.friends.length, beforeFriends)
  })

  it('getConfig 摘要无密钥明文；diff 摘要可读', async () => {
    const ctx = await boot()
    directory = ctx.directory
    await ctx.vault.upsert({ name: 'x', kind: 'api-key', apiKey: 'sk-should-not-leak' })
    const summary = await ctx.proposals.getConfigSummary('all')
    assert.match(summary, /提供方/)
    assert.match(summary, /应用设置/)
    assert.equal(summary.includes('sk-should-not-leak'), false)
    assert.match(summary, /session_prefs/)
    assert.equal(
      diffAppSettingsSummary({ sendWaitSeconds: 2, mailInstructions: { enabled: true } }),
      '发送等待 → 2s；邮箱通道 → 开',
    )
    const doc = await ctx.database.read()
    assert.match(summarizeConfigForModel(doc, 'friends'), /好友/)
  })

  it('确认失败整笔可重试：错误好友仍 pending', async () => {
    const ctx = await boot()
    directory = ctx.directory
    const pending = await ctx.proposals.stage({
      conversationId: 'c1',
      kind: 'friend_patch',
      name: '幽灵',
      draft: { friendId: 'missing-friend', systemPrompt: 'x' },
    })
    await assert.rejects(() => ctx.proposals.confirm(pending.id, 'global'), /不存在/)
    const again = (await ctx.database.read()).stores.proposals.find((item) => item.id === pending.id)
    assert.equal(again?.status, 'pending')
    assert.ok(again?.error)
  })
})

async function boot() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-p14-'))
  const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
  await seedIfEmpty(database)
  const vault = createVault(database, path.join(directory, 'vault.key'))
  const proposals = createProposalService(database, vault)
  return { directory, database, vault, proposals }
}
