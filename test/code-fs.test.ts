import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { grepWorkspace, listWorkspace, readWorkspaceFile } from '../src/app/code-fs.ts'
import type { Friend } from '../src/domain/types.ts'
import { DEFAULT_FRIEND_AVATAR } from '../src/domain/types.ts'

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

describe('code-fs 只读服务', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('未绑定：list/read/grep 全禁，人话提示，磁盘零访问', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-unbound-'))
    const secret = path.join(directory, 'SHOULD_NOT_TOUCH.txt')
    await writeFile(secret, 'secret-before', 'utf8')
    const unbound = friend({ id: 'f1', name: '编码助手' })

    await assert.rejects(() => listWorkspace(unbound, '.'), /绑定 Workspace|选择本机目录/)
    await assert.rejects(() => readWorkspaceFile(unbound, 'SHOULD_NOT_TOUCH.txt'), /绑定 Workspace|选择本机目录/)
    await assert.rejects(() => grepWorkspace(unbound, 'secret'), /绑定 Workspace|选择本机目录/)

    assert.equal(await readFile(secret, 'utf8'), 'secret-before')
  })

  it('绑定后 list/read；越界拒绝且不读界外文件', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-bound-'))
    const ws = path.join(directory, 'ws')
    const outside = path.join(directory, 'outside.txt')
    await mkdir(ws)
    await writeFile(path.join(ws, 'README.md'), '# hello\n', 'utf8')
    await writeFile(outside, 'OUTSIDE', 'utf8')
    const bound = friend({ id: 'f1', name: '编码助手', workspacePath: ws })

    const listed = await listWorkspace(bound, '.')
    assert.ok(listed.entries.some((e) => e.name === 'README.md'))

    const read = await readWorkspaceFile(bound, 'README.md')
    assert.match(read.content, /hello/)
    assert.equal(read.relativePath, 'README.md')

    await assert.rejects(() => readWorkspaceFile(bound, '../outside.txt'), /Workspace 内/)
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE')
  })

  it('grep 命中相对路径', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-code-grep-'))
    await writeFile(path.join(directory, 'a.ts'), 'const foo = 1\n', 'utf8')
    const bound = friend({ id: 'f1', name: '编码助手', workspacePath: directory })
    const result = await grepWorkspace(bound, 'foo')
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]?.relativePath, 'a.ts')
  })
})
