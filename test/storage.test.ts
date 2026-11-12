import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createConversation, deleteConversation, listConversations } from '../src/app/conversations.ts'
import { listProviders, upsertProvider } from '../src/app/providers.ts'
import { listFriends } from '../src/app/friends.ts'
import { recall } from '../src/memory/recall.ts'
import { findExistingRun } from '../src/session/dedup.ts'
import { listSkillDrafts } from '../src/skills/catalog.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { DB_NAME, DB_VERSION, STORE_NAMES, emptyDocument } from '../src/storage/schema.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('agent_workbench 文件库', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('种入 Ollama 和带默认头像的群主，且不覆盖已有修改', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const providers = await listProviders(repos)
    const friends = await listFriends(repos)
    assert.equal(providers.length, 6)
    assert.partialDeepStrictEqual(providers.find((item) => item.id === 'ollama-local'), {
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
      apiKeyPolicy: 'none',
    })
    assert.equal(providers.find((item) => item.id === 'openai')?.enabled, false)
    assert.equal(providers.find((item) => item.id === 'deepseek')?.apiKeyPolicy, 'required')
    assert.partialDeepStrictEqual(providers.find((item) => item.id === 'dashscope'), {
      name: '阿里云百炼',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      enabled: false,
      apiKeyPolicy: 'required',
      defaultModel: 'qwen-plus',
    })
    assert.partialDeepStrictEqual(providers.find((item) => item.id === 'cursor'), {
      name: 'Cursor',
      baseUrl: 'https://api.cursor.com/v1',
      enabled: false,
      apiKeyPolicy: 'required',
      defaultModel: 'composer-2.5',
      probedModels: [
        'composer-2.5',
        'composer-2.5-fast',
        'grok-4.7',
        'grok-4.7-fast',
        'grok-4.6',
        'grok-4.6-fast',
        'grok-4.5',
        'grok-4.5-fast',
        'auto-smart',
      ],
    })
    assert.deepEqual((await listConversations(repos)).map((item) => ({ title: item.title, kind: item.kind, friendIds: item.friendIds })), [
      { title: '群主', kind: 'direct', friendIds: ['role-owner'] },
    ])
    assert.partialDeepStrictEqual(friends[0], {
      id: 'role-owner',
      name: '群主',
      isOwnerTemplate: true,
      providerId: 'ollama-local',
      avatar: { kind: 'default', id: 'seal', path: '/avatars/defaults/seal.svg' },
    })

    const saved = await upsertProvider(repos, {
      id: 'ollama-local',
      name: 'LM Studio',
      baseUrl: 'http://127.0.0.1:1234/v1/',
    })
    assert.equal(saved.baseUrl, 'http://127.0.0.1:1234/v1')
    await seedIfEmpty(database)
    assert.equal((await listProviders(repos)).find((item) => item.id === 'ollama-local')?.name, 'LM Studio')
    assert.equal((await listProviders(repos)).length, 6)

    const document = await database.read()
    assert.equal(document.name, DB_NAME)
    assert.equal(document.version, DB_VERSION)
    assert.deepEqual(Object.keys(document.stores).sort(), [...STORE_NAMES].sort())
  })

  it('级联删除会话，并守住 run 的幂等键', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const conversation = await createConversation(repos, '周记')
    // 同毫秒时按标题排序，「群主」会排前；这里只校验两个会话都在，新建的周记 updatedAt 应不低于群主。
    {
      const listed = await listConversations(repos)
      assert.deepEqual(new Set(listed.map((item) => item.title)), new Set(['周记', '群主']))
      const weekly = listed.find((item) => item.title === '周记')!
      const owner = listed.find((item) => item.title === '群主')!
      assert.ok(weekly.updatedAt >= owner.updatedAt)
    }

    await repos.messages.put({
      id: 'm1',
      conversationId: conversation.id,
      role: 'user',
      content: '先写的',
      status: 'complete',
      createdAt: 10,
    })
    await repos.runs.put({
      id: 'run-1',
      conversationId: conversation.id,
      status: 'queued',
      idempotencyKey: `${conversation.id}:turn-1`,
      providerId: 'ollama-local',
      model: 'qwen',
      createdAt: 11,
    })
    await assert.rejects(
      repos.runs.put({
        id: 'run-2',
        conversationId: conversation.id,
        status: 'queued',
        idempotencyKey: `${conversation.id}:turn-1`,
        providerId: 'ollama-local',
        model: 'qwen',
        createdAt: 12,
      }),
      /幂等键已存在/,
    )
    assert.equal((await findExistingRun(repos, `${conversation.id}:turn-1`))?.id, 'run-1')

    await repos.summaries.put({
      id: 'sum-1',
      conversationId: conversation.id,
      content: '在整理周记',
      createdAt: 13,
      updatedAt: 13,
    })
    await repos.skills.put({
      id: 'skill-1',
      name: '周报',
      description: '收成周报',
      body: '先列事实',
      status: 'draft',
      createdAt: 14,
      updatedAt: 14,
    })
    await repos.assignments.put({
      id: 'asg-1',
      conversationId: conversation.id,
      fromFriendId: 'role-owner',
      toFriendId: 'role-owner',
      instruction: '列出未完成事项',
      status: 'pending',
      createdAt: 15,
      updatedAt: 15,
    })

    const memory = await recall(repos, conversation.id)
    assert.equal(memory.summary?.content, '在整理周记')
    assert.equal(memory.recentMessages.length, 1)
    assert.equal((await listSkillDrafts(repos)).length, 1)

    await deleteConversation(repos, conversation.id)
    assert.deepEqual((await listConversations(repos)).map((item) => item.title), ['群主'])
    assert.deepEqual(await repos.messages.listByConversation(conversation.id), [])
    assert.deepEqual(await repos.runs.listByConversation(conversation.id), [])
    assert.deepEqual(await repos.summaries.listByConversation(conversation.id), [])
    assert.deepEqual(await repos.assignments.listByConversation(conversation.id), [])
    assert.equal((await listSkillDrafts(repos)).length, 1)
  })

  it('旧 roles 会迁成 friends，roleIds 会迁成 friendIds', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-'))
    const file = path.join(directory, 'agent_workbench.json')
    const document = emptyDocument()
    const legacy = document as unknown as { stores: { roles: unknown[]; friends?: unknown[]; conversations: unknown[] } }
    delete legacy.stores.friends
    legacy.stores.roles = [
      {
        id: 'role-owner',
        name: '群主',
        description: '',
        systemPrompt: '',
        isOwnerTemplate: true,
        avatar: { kind: 'default', id: 'seal' },
        providerId: 'ollama-local',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    legacy.stores.conversations = [
      {
        id: 'c1',
        title: '旧会话',
        kind: 'direct',
        roleIds: ['role-owner'],
        providerId: 'ollama-local',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    await writeFile(file, JSON.stringify(document))
    const database = await openDatabase(file)
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      stores: { roles?: unknown; friends: { name: string }[]; conversations: { friendIds?: string[]; roleIds?: string[] }[] }
    }
    assert.equal(stored.stores.roles, undefined)
    assert.equal(stored.stores.friends[0]?.name, '群主')
    assert.deepEqual(stored.stores.conversations[0]?.friendIds, ['role-owner'])
    assert.equal(stored.stores.conversations[0]?.roleIds, undefined)
    assert.equal((await database.read()).stores.friends.length, 1)
  })
})
