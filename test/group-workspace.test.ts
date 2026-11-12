/**
 * 群工作空间：成员目录是「根目录/群名/好友名」，写和删直接落盘。
 * 好友自己的 workspacePath 和单聊确认门闩保持不变。
 */

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createCodeActionService } from '../src/app/code-actions.ts'
import { callCodeTool } from '../src/app/code-tools.ts'
import { friendInWorkspace, resolveMemberWorkspace } from '../src/app/code-workspace.ts'
import { workspaceDirectoryPrompt } from '../src/domain/group-workspace.ts'
import { createConversation, startFreshThread, updateGroupConversation } from '../src/app/conversations.ts'
import type { Conversation, Friend } from '../src/domain/types.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('群工作空间', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    await rm(target, { recursive: true, force: true })
  })

  it('自动子目录、手动覆盖、名字不能逃出根目录，且不改好友自己的目录', async () => {
    const { repos, owner } = await boot()
    const personal = path.join(directory, 'personal')
    const dev: Friend = {
      ...owner,
      id: 'friend-a',
      name: '好友A',
      isOwnerTemplate: false,
      workspacePath: personal,
      codePermission: 'read-only',
    }
    await repos.friends.put(dev)
    const root = path.join(directory, 'xxxx')
    const group = await createConversation(repos, '开发群', {
      kind: 'group',
      friendIds: [owner.id, dev.id],
      workspaceRoot: root,
    })

    const ownerDir = path.join(path.resolve(root), '开发群', '群主')
    assert.match(workspaceDirectoryPrompt(ownerDir), new RegExp(`^你的工作目录是 ${ownerDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(workspaceDirectoryPrompt(ownerDir), /不要用 \.\./)
    assert.equal(workspaceDirectoryPrompt('  '), '')
    const devDir = path.join(path.resolve(root), '开发群', '好友A')
    await access(ownerDir)
    await access(devDir)
    assert.equal(resolveMemberWorkspace(group, owner).root, ownerDir)
    assert.equal(resolveMemberWorkspace(group, dev).root, devDir)
    assert.equal(resolveMemberWorkspace(group, dev).autoFileOps, true)
    assert.equal((await repos.friends.get(dev.id))?.workspacePath, personal)
    assert.equal((await repos.friends.get(dev.id))?.codePermission, 'read-only')

    const manual = path.join(directory, 'manual-a')
    const updated = await updateGroupConversation(repos, group.id, {
      title: '开发群',
      friendIds: [owner.id, dev.id],
      memberWorkspaces: { [dev.id]: manual },
    })
    assert.equal(resolveMemberWorkspace(updated, dev).root, path.resolve(manual))
    assert.equal(resolveMemberWorkspace(updated, dev).source, 'manual')
    assert.equal(resolveMemberWorkspace(updated, owner).root, ownerDir)
    await access(manual)

    const sneaky = resolveMemberWorkspace(
      { ...updated, memberWorkspaces: undefined, workspaceRoot: root },
      { ...dev, name: '../逃出' },
    )
    assert.equal(sneaky.autoFileOps, true)
    assert.ok(sneaky.root.startsWith(path.resolve(root) + path.sep))
    assert.equal(path.relative(path.resolve(root), sneaky.root).startsWith('..'), false)

    const fresh = await startFreshThread(repos, updated.id)
    assert.equal(fresh.workspaceRoot, path.resolve(root))
    assert.equal(fresh.memberWorkspaces?.[dev.id], path.resolve(manual))
  })

  it('群目录里写和删直接落盘；shell 和单聊写入仍要确认', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-group-ws-ops-'))
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const personal = path.join(directory, 'personal')
    const root = path.join(directory, 'xxxx')
    const dev = friend({
      id: 'friend-a',
      name: '好友A',
      workspacePath: personal,
      codePermission: 'read-only',
    })
    const group = {
      kind: 'group',
      title: '开发群',
      workspaceRoot: root,
    } as Conversation
    const acting = friendInWorkspace(dev, resolveMemberWorkspace(group, dev))
    const memberDir = path.join(path.resolve(root), '开发群', '好友A')

    const written = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'note.txt', content: 'hi' }),
      { friend: acting, conversationId: 'g1', actions, autoFileOps: true },
    )
    assert.match(written, /已写入/)
    assert.equal(await readFile(path.join(memberDir, 'note.txt'), 'utf8'), 'hi')
    assert.equal(dev.workspacePath, personal)
    assert.equal(dev.codePermission, 'read-only')

    const removed = await callCodeTool(
      'workbench_fs_delete',
      JSON.stringify({ path: 'note.txt' }),
      { friend: acting, conversationId: 'g1', actions, autoFileOps: true },
    )
    assert.match(removed, /已删除/)
    await assert.rejects(() => access(path.join(memberDir, 'note.txt')))

    const shell = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'echo should-not-run' }),
      { friend: acting, conversationId: 'g1', actions, autoFileOps: true },
    )
    assert.match(shell, /确认卡/)

    const directFriend = friend({ id: 'friend-direct', name: '单聊', workspacePath: personal })
    await mkdir(personal, { recursive: true })
    await writeFile(path.join(personal, 'keep.txt'), 'stay', 'utf8')
    const directWrite = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'keep.txt', content: 'changed' }),
      { friend: directFriend, conversationId: 'd1', actions },
    )
    assert.match(directWrite, /确认卡/)
    assert.equal(await readFile(path.join(personal, 'keep.txt'), 'utf8'), 'stay')

    const pending = (await db.read()).stores.codeActions.filter((item) => item.status === 'pending')
    assert.equal(pending.length, 2)
    assert.deepEqual(
      pending.map((item) => item.kind).sort(),
      ['shell', 'write'],
    )

    const danger = friend({
      id: 'friend-danger',
      name: '好友A',
      workspacePath: personal,
      codePermission: 'danger-full-access',
    })
    const dangerActing = friendInWorkspace(danger, resolveMemberWorkspace(group, danger))
    assert.equal(dangerActing.codePermission, 'danger-full-access')
    const dangerShell = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'echo open' }),
      { friend: dangerActing, conversationId: 'g1', actions, autoFileOps: true },
    )
    assert.match(dangerShell, /已执行命令/)
    assert.match(dangerShell, /危险全开，无需确认/)
    assert.doesNotMatch(dangerShell, /确认卡/)
  })

  async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-group-ws-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    return { repos, owner }
  }
})

function friend(partial: Partial<Friend> & Pick<Friend, 'id' | 'name'>): Friend {
  const now = Date.now()
  return {
    description: '',
    systemPrompt: '',
    isOwnerTemplate: false,
    avatar: { kind: 'default', id: 'seal' },
    providerId: 'ollama-local',
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}
