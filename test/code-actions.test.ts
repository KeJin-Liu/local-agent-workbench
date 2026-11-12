import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createCodeActionService } from '../src/app/code-actions.ts'
import { callCodeTool } from '../src/app/code-tools.ts'
import type { Friend } from '../src/domain/types.ts'
import { DEFAULT_FRIEND_AVATAR } from '../src/domain/types.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

function friend(partial: Partial<Friend> & Pick<Friend, 'id' | 'name'>): Friend {
  const now = Date.now()
  return {
    description: '',
    systemPrompt: '',
    isOwnerTemplate: false,
    avatar: { ...DEFAULT_FRIEND_AVATAR },
    providerId: 'p1',
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

describe('code-actions 门闩', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('未绑定：write/shell 工具人话拒绝，磁盘零访问', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-act-unbound-'))
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const target = path.join(directory, 'nope.txt')
    await writeFile(target, 'before', 'utf8')
    const unbound = friend({ id: 'f1', name: '编码助手' })

    const writeMsg = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'nope.txt', content: 'after' }),
      { friend: unbound, conversationId: 'c1', actions },
    )
    assert.match(writeMsg, /绑定 Workspace|选择本机目录/)

    const shellMsg = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: `echo pwned > ${target}` }),
      { friend: unbound, conversationId: 'c1', actions },
    )
    assert.match(shellMsg, /绑定 Workspace|选择本机目录/)

    assert.equal(await readFile(target, 'utf8'), 'before')
    assert.equal((await db.read()).stores.codeActions.length, 0)
  })

  it('write：确认前磁盘不变；确认后变更；cancel 不变', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-write-'))
    const ws = path.join(directory, 'ws')
    await (await import('node:fs/promises')).mkdir(ws)
    const file = path.join(ws, 'note.txt')
    await writeFile(file, 'v1', 'utf8')
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const bound = friend({ id: 'f1', name: '编码助手', workspacePath: ws })

    const staged = await actions.stageWrite({
      conversationId: 'c1',
      friend: bound,
      relativePath: 'note.txt',
      content: 'v2',
    })
    assert.equal(staged.status, 'pending')
    assert.equal(await readFile(file, 'utf8'), 'v1')

    const cancelled = await actions.stageWrite({
      conversationId: 'c1',
      friend: bound,
      relativePath: 'note.txt',
      content: 'should-not-apply',
    })
    await actions.cancel(cancelled.id)
    assert.equal(await readFile(file, 'utf8'), 'v1')

    const confirmed = await actions.confirm(staged.id)
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(await readFile(file, 'utf8'), 'v2')
  })

  it('shell：stage 不执行；cancel 不执行；confirm 有 exitCode', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-shell-'))
    const ws = path.join(directory, 'ws')
    await (await import('node:fs/promises')).mkdir(ws)
    const sentinel = path.join(ws, 'ran.txt')
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const bound = friend({ id: 'f1', name: '编码助手', workspacePath: ws })

    const rejected = await actions.stageShell({
      conversationId: 'c1',
      friend: bound,
      command: 'echo ran > ran.txt',
    })
    await assert.rejects(async () => access(sentinel, constants.F_OK))
    await actions.cancel(rejected.id)
    await assert.rejects(async () => access(sentinel, constants.F_OK))

    const staged = await actions.stageShell({
      conversationId: 'c1',
      friend: bound,
      command: 'echo ran > ran.txt && echo ok',
    })
    await assert.rejects(async () => access(sentinel, constants.F_OK))
    const done = await actions.confirm(staged.id)
    assert.equal(done.status, 'confirmed')
    assert.equal(done.result?.exitCode, 0)
    assert.equal(await readFile(sentinel, 'utf8'), 'ran\n')
  })

  it('read-only 档：stage write/shell 被拒', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-ro-'))
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const ro = friend({
      id: 'f1',
      name: '只读',
      workspacePath: directory,
      codePermission: 'read-only',
    })
    await assert.rejects(
      () => actions.stageWrite({ conversationId: 'c1', friend: ro, relativePath: 'x.txt', content: 'x' }),
      /只读/,
    )
    await assert.rejects(
      () => actions.stageShell({ conversationId: 'c1', friend: ro, command: 'true' }),
      /只读/,
    )
  })

  it('danger 档：写文件和 shell 直接执行，不留待确认卡', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-danger-run-'))
    const ws = path.join(directory, 'ws')
    await (await import('node:fs/promises')).mkdir(ws)
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const danger = friend({
      id: 'f1',
      name: '危险',
      workspacePath: ws,
      codePermission: 'danger-full-access',
    })

    const written = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'note.txt', content: 'now' }),
      { friend: danger, conversationId: 'c1', actions },
    )
    assert.match(written, /已写入/)
    assert.match(written, /危险全开，无需确认/)
    assert.equal(await readFile(path.join(ws, 'note.txt'), 'utf8'), 'now')

    const shell = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'echo ran' }),
      { friend: danger, conversationId: 'c1', actions },
    )
    assert.match(shell, /已执行命令/)
    assert.match(shell, /危险全开，无需确认/)
    assert.match(shell, /退出码：0/)
    assert.match(shell, /ran/)
    assert.equal((await db.read()).stores.codeActions.filter((item) => item.status === 'pending').length, 0)
  })

  it('shell 拒绝用 .. 离开工作目录，目录内命令和 /dev/null 仍可出示', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-shell-sandbox-'))
    const ws = path.join(directory, 'ws')
    await (await import('node:fs/promises')).mkdir(ws)
    const outside = path.join(directory, 'outside.txt')
    await writeFile(outside, 'keep', 'utf8')
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const bound = friend({
      id: 'f1',
      name: '编码助手',
      workspacePath: ws,
      codePermission: 'danger-full-access',
    })

    const escaped = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'cp note.txt ../outside.txt' }),
      { friend: bound, conversationId: 'c1', actions },
    )
    assert.match(escaped, /不能用 \.\./)
    assert.equal(await readFile(outside, 'utf8'), 'keep')

    const listed = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'echo ok 2>/dev/null' }),
      { friend: bound, conversationId: 'c1', actions },
    )
    assert.match(listed, /已执行命令/)
    assert.match(listed, /退出码：0/)
  })

  it('danger 档仍受沙箱约束（越界写拒绝）', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-danger-'))
    const ws = path.join(directory, 'ws')
    await (await import('node:fs/promises')).mkdir(ws)
    const db = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(db)
    const actions = createCodeActionService(db)
    const danger = friend({
      id: 'f1',
      name: '危险',
      workspacePath: ws,
      codePermission: 'danger-full-access',
    })
    await assert.rejects(
      () =>
        actions.stageWrite({
          conversationId: 'c1',
          friend: danger,
          relativePath: '../escape.txt',
          content: 'nope',
        }),
      /Workspace 内/,
    )
  })
})
