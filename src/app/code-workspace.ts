/**
 * p1.1 Workspace 路径沙箱：相对路径落在 root 内；越界人话拒绝。
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from './errors.ts'
import { previewMemberWorkspace, type MemberWorkspacePreview } from '../domain/group-workspace.ts'
import type { CodePermission, Conversation, Friend } from '../domain/types.ts'

export function normalizeWorkspaceRoot(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new AppError(400, '请先在好友设置里绑定 Workspace 目录。')
  return path.resolve(trimmed)
}

/**
 * 把用户/模型给出的路径解析到 workspace 内的绝对路径。
 * 相对路径基于 root；绝对路径也必须落在 root 下。
 */
export function resolveInWorkspace(workspaceRoot: string, inputPath: string): {
  absolute: string
  relative: string
} {
  const root = normalizeWorkspaceRoot(workspaceRoot)
  const raw = (inputPath ?? '').trim() || '.'
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(400, '只能访问已绑定 Workspace 内的路径，请改用相对路径。')
  }
  return {
    absolute,
    relative: relative === '' ? '.' : relative.split(path.sep).join('/'),
  }
}

export function friendWorkspaceOrThrow(friend: Pick<Friend, 'workspacePath' | 'name'>): string {
  const raw = friend.workspacePath?.trim()
  if (!raw) {
    throw new AppError(400, `好友「${friend.name}」还没有绑定 Workspace，请先在设置里选择本机目录。`)
  }
  return normalizeWorkspaceRoot(raw)
}

export function effectiveCodePermission(friend: Pick<Friend, 'codePermission'>): CodePermission {
  return friend.codePermission ?? 'workspace-write'
}

export function canReadCode(friend: Pick<Friend, 'workspacePath' | 'codePermission'>): boolean {
  return Boolean(friend.workspacePath?.trim())
}

/** 危险全开：写、删、shell 直接执行。仍不能越出 Workspace。 */
export function executesWithoutConfirm(friend: Pick<Friend, 'codePermission'>): boolean {
  return effectiveCodePermission(friend) === 'danger-full-access'
}

export function canWriteOrShell(friend: Pick<Friend, 'workspacePath' | 'codePermission'>): boolean {
  if (!friend.workspacePath?.trim()) return false
  const perm = effectiveCodePermission(friend)
  return perm === 'workspace-write' || perm === 'danger-full-access'
}

export function assertCanRead(friend: Friend): string {
  if (!canReadCode(friend)) {
    throw new AppError(400, `好友「${friend.name}」还没有绑定 Workspace，请先在设置里选择本机目录。`)
  }
  return friendWorkspaceOrThrow(friend)
}

export function assertCanWriteOrShell(friend: Friend): string {
  assertCanRead(friend)
  if (!canWriteOrShell(friend)) {
    throw new AppError(400, '当前权限为只读，不能改文件或执行命令。请在好友设置里调整编码权限。')
  }
  return friendWorkspaceOrThrow(friend)
}

const SHELL_DEVICE_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty'])

/**
 * shell 的 cwd 在工作目录里，但命令文本仍可以 `..`、`~` 或绝对路径写到别处。
 * 文件工具已经拒绝越界，这里用同一条边界拦住命令。返回拒绝原因；通过则返回空串。
 */
export function shellWorkspaceViolation(command: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot)
  if (/(?:^|[^\w.])\.\.(?:$|[^\w.])/.test(command)) {
    return '命令不能用 .. 离开工作目录。请改用工作目录内的相对路径。'
  }
  if (/(?:^|[\s|&;<>'"])~(?:\/|\s|$|['"])/.test(command) || /\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/.test(command)) {
    return '命令不能用 ~ 或 $HOME 离开工作目录。'
  }
  for (const abs of shellAbsolutePaths(command)) {
    if (abs.startsWith('//') || SHELL_DEVICE_PATHS.has(abs)) continue
    const rel = path.relative(root, path.resolve(abs))
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return `命令里的路径「${abs}」不在工作目录内。`
    }
  }
  return ''
}

export function assertShellStaysInWorkspace(command: string, workspaceRoot: string): void {
  const reason = shellWorkspaceViolation(command, workspaceRoot)
  if (reason) throw new AppError(400, reason)
}

/** 抽出命令里以 / 开头的路径。`://` 视为网址，不记。`//` 由调用方跳过。 */
function shellAbsolutePaths(command: string): string[] {
  const found: string[] = []
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== '/') continue
    const previous = index > 0 ? command[index - 1] ?? '' : ''
    if (previous === ':' || previous === '/') continue
    if (previous && !/[\s'"=|&;<>]/.test(previous)) continue
    let end = index + 1
    while (end < command.length && !/[\s'"|&;<>]/.test(command[end] ?? '')) end += 1
    found.push(command.slice(index, end))
    index = end
  }
  return found
}

/**
 * 群里有根目录或手动目录时，用那份路径，并允许写/删直接落盘。
 * 都没有时回退好友自己的 workspacePath，仍走确认门闩。不改好友原对象。
 */
export function resolveMemberWorkspace(
  conversation: Pick<Conversation, 'kind' | 'title' | 'workspaceRoot' | 'memberWorkspaces'> | null | undefined,
  friend: Pick<Friend, 'id' | 'name' | 'workspacePath'>,
): MemberWorkspacePreview & { root: string } {
  const preview = previewMemberWorkspace(conversation, friend)
  return {
    ...preview,
    root: preview.path ? path.resolve(preview.path) : '',
  }
}

/** 编码工具用的好友副本：群目录覆盖 workspacePath，不写回资料。 */
export function friendInWorkspace<T extends Friend>(
  friend: T,
  resolved: { root: string; autoFileOps: boolean },
): T {
  if (!resolved.root) return friend
  return {
    ...friend,
    workspacePath: resolved.root,
    // 群目录把只读抬成可写，但危险全开要保留，否则 shell 又会退回确认。
    ...(resolved.autoFileOps && !executesWithoutConfirm(friend)
      ? { codePermission: 'workspace-write' as const }
      : {}),
  }
}

/** 群自动目录和手动目录在真正用到前建出来。已存在则不动。 */
export async function ensureWorkspaceRoot(root: string): Promise<void> {
  const trimmed = root.trim()
  if (!trimmed) return
  try {
    await mkdir(trimmed, { recursive: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AppError(400, `建不了工作目录。请检查群工作空间是否可写。（${detail}）`)
  }
}
