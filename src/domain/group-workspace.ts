/**
 * 群成员目录的纯字符串规则。页面和 Node 共用，不依赖 node:path。
 * 实际落盘前再由 code-workspace 做 path.resolve。
 */

export type MemberWorkspaceSource = 'group' | 'manual' | 'friend' | 'none'

export type MemberWorkspacePreview = {
  path: string
  autoFileOps: boolean
  source: MemberWorkspaceSource
}

/** 目录名里的斜杠和 .. 换成下划线，避免成员名逃出群根目录。 */
export function sanitizeWorkspaceSegment(name: string): string {
  const replaced = name.trim().replace(/[\\/]/g, '_').replace(/\.\./g, '_')
  const cleaned = replaced.replace(/^\.+$/, '_')
  return cleaned || '_'
}

/**
 * 本群实际注入的提示词。群里只认 memberPrompts；没保存过就是空。
 * 单聊仍用好友资料里的 systemPrompt。
 */
/**
 * 调用模型时写明这位成员实际使用的目录。
 * 群里取「根目录/群名/成员名」或手动目录；单聊取好友自己的 workspacePath。
 * 任务正文里如果点了别人的路径，仍以这一句为准。
 */
export function workspaceDirectoryPrompt(directory: string): string {
  const root = directory.trim()
  if (!root) return ''
  return `你的工作目录是 ${root}。文件、计划和命令都只放在这个目录里；任务里如果出现别的路径，以这个目录为准，不要写到其他成员的目录。不要用 ..、~ 或工作目录以外的绝对路径绕出去。`
}

export function groupMemberSystemPrompt(
  conversation: { kind?: string; memberPrompts?: Record<string, string> } | null | undefined,
  friend: { id: string; systemPrompt?: string },
): string {
  if (conversation?.kind === 'group') return conversation.memberPrompts?.[friend.id]?.trim() ?? ''
  return friend.systemPrompt?.trim() ?? ''
}

export function previewMemberWorkspace(
  conversation: {
    kind?: string
    title?: string
    workspaceRoot?: string
    memberWorkspaces?: Record<string, string>
  } | null | undefined,
  friend: { id: string; name: string; workspacePath?: string },
): MemberWorkspacePreview {
  if (conversation?.kind === 'group') {
    const manual = conversation.memberWorkspaces?.[friend.id]?.trim()
    if (manual) return { path: manual, autoFileOps: true, source: 'manual' }
    const root = conversation.workspaceRoot?.trim().replace(/[\\/]+$/, '')
    if (root) {
      const title = sanitizeWorkspaceSegment(conversation.title ?? '')
      const who = sanitizeWorkspaceSegment(friend.name)
      return { path: `${root}/${title}/${who}`, autoFileOps: true, source: 'group' }
    }
  }
  const personal = friend.workspacePath?.trim() ?? ''
  if (personal) return { path: personal, autoFileOps: false, source: 'friend' }
  return { path: '', autoFileOps: false, source: 'none' }
}
