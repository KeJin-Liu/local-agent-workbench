import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  canReadCode,
  canWriteOrShell,
  effectiveCodePermission,
  normalizeWorkspaceRoot,
  resolveInWorkspace,
  shellWorkspaceViolation,
} from '../src/app/code-workspace.ts'
import { AppError } from '../src/app/errors.ts'

describe('code-workspace 沙箱', () => {
  it('空 root 拒绝', () => {
    assert.throws(() => normalizeWorkspaceRoot(''), AppError)
    assert.throws(() => normalizeWorkspaceRoot('   '), /绑定 Workspace/)
  })

  it('相对路径落在 root 内', () => {
    const root = path.resolve('/tmp/wb-ws-root')
    const resolved = resolveInWorkspace(root, 'src/a.ts')
    assert.equal(resolved.relative, 'src/a.ts')
    assert.equal(resolved.absolute, path.join(root, 'src/a.ts'))
  })

  it('shell 拒绝 ..、家目录和工作目录外的绝对路径', () => {
    const root = path.resolve('/tmp/wb-ws-root')
    assert.match(shellWorkspaceViolation('ls -la ..', root), /\.\./)
    assert.match(shellWorkspaceViolation('cp "a.html" "../群主/a.html"', root), /\.\./)
    assert.equal(shellWorkspaceViolation('echo 1.2..1.3', root), '')
    assert.match(shellWorkspaceViolation('echo ~', root), /~/)
    assert.match(shellWorkspaceViolation('echo $HOME', root), /\$HOME/)
    assert.match(shellWorkspaceViolation(`cp a.html ${path.join(root, '..', 'out.html')}`, root), /不在工作目录/)
    assert.equal(shellWorkspaceViolation(`wc ${path.join(root, 'a.html')}`, root), '')
    assert.equal(shellWorkspaceViolation('echo ok 2>/dev/null', root), '')
    assert.equal(shellWorkspaceViolation('grep -nE "https?://|//cdn" file.html', root), '')
  })

  it('../ 与绝对越界拒绝', () => {
    const root = path.resolve('/tmp/wb-ws-root')
    assert.throws(() => resolveInWorkspace(root, '../outside'), /Workspace 内/)
    assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), /Workspace 内/)
  })

  it('未绑定不可读不可写；danger 仍算可写档但不表示绕沙箱', () => {
    assert.equal(canReadCode({}), false)
    assert.equal(canWriteOrShell({}), false)
    assert.equal(canReadCode({ workspacePath: '/tmp/x' }), true)
    assert.equal(canWriteOrShell({ workspacePath: '/tmp/x', codePermission: 'read-only' }), false)
    assert.equal(canWriteOrShell({ workspacePath: '/tmp/x' }), true)
    assert.equal(canWriteOrShell({ workspacePath: '/tmp/x', codePermission: 'danger-full-access' }), true)
    assert.equal(effectiveCodePermission({}), 'workspace-write')
  })
})
