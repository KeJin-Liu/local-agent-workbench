/**
 * p1.1 编码工具 OpenAI function 定义与调用分发（不依赖 UI）。
 */

import type { Friend } from '../domain/types.ts'
import type { OpenAiTool } from '../mcp/hub.ts'
import { AppError } from './errors.ts'
import type { CodeActionService } from './code-actions.ts'
import { grepWorkspace, listWorkspace, readWorkspaceFile } from './code-fs.ts'
import { canReadCode, canWriteOrShell, ensureWorkspaceRoot, executesWithoutConfirm } from './code-workspace.ts'

export const CODE_TOOL_NAMES = [
  'workbench_fs_list',
  'workbench_fs_read',
  'workbench_fs_grep',
  'workbench_fs_write',
  'workbench_fs_delete',
  'workbench_shell',
] as const

export type CodeToolName = (typeof CODE_TOOL_NAMES)[number]

const DIRECT_TOOL_DESCRIPTIONS: Partial<Record<CodeToolName, string>> = {
  workbench_fs_write:
    '直接写入 Workspace 内文件并返回结果。危险全开不再出确认卡。path 为相对路径，content 为全文。',
  workbench_fs_delete:
    '直接删除 Workspace 内的一个文件或空目录。危险全开不再出确认卡。不能删工作目录本身，也不能删非空目录。',
  workbench_shell:
    '直接在 Workspace 根目录执行 shell 命令并返回退出码和输出。危险全开不再出确认卡。命令不能使用 ..、~ 或工作目录以外的绝对路径。',
}

/** 危险全开时改写工具说明，避免模型仍按「只出确认卡」来回话。 */
export function presentCodeTools(tools: OpenAiTool[], friend: Pick<Friend, 'codePermission'>): OpenAiTool[] {
  if (!executesWithoutConfirm(friend)) return tools
  return tools.map((tool) => {
    const description = DIRECT_TOOL_DESCRIPTIONS[tool.function.name as CodeToolName]
    if (!description) return tool
    return { ...tool, function: { ...tool.function, description } }
  })
}

export function isCodeToolName(name: string): name is CodeToolName {
  return (CODE_TOOL_NAMES as readonly string[]).includes(name)
}

export const CODE_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'workbench_fs_list',
      description: '列出已绑定 Workspace 内的目录。path 为相对路径，默认根目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workbench_fs_read',
      description: '读取 Workspace 内文本文件。返回相对路径与内容（过大将截断）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workbench_fs_grep',
      description: '在 Workspace 内按正则或字面量搜索文件内容。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workbench_fs_write',
      description:
        '提议写入 Workspace 内文件。只生成确认卡，用户确认前磁盘不变。path 相对路径，content 为拟写入全文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          unifiedDiff: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workbench_fs_delete',
      description:
        '删除 Workspace 内的一个文件或空目录。默认只出示确认卡，用户确认前不会删除。群工作空间里会直接删除。不能删工作目录本身，也不能删非空目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workbench_shell',
      description:
        '提议在 Workspace 根目录执行 shell 命令。只生成确认卡，用户批准前不会执行。命令不能使用 ..、~ 或工作目录以外的绝对路径，否则会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
      },
    },
  },
]

export type CodeToolContext = {
  friend: Friend
  conversationId: string
  runId?: string
  actions: CodeActionService
  /** 无人值守任务（邮件）：写文件、删除和 shell 直接确认执行，不等待气泡。 */
  autoConfirm?: boolean
  /** 群工作空间：只让写文件和删除直接执行，shell 仍出确认卡。 */
  autoFileOps?: boolean
}

export async function callCodeTool(
  name: CodeToolName,
  argsJson: string,
  ctx: CodeToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return '参数不是 JSON，没有执行。'
  }

  try {
    if (!canReadCode(ctx.friend)) {
      await ctx.actions.recordTimeline({
        conversationId: ctx.conversationId,
        friendId: ctx.friend.id,
        runId: ctx.runId,
        toolName: name,
        detail: String(args.path ?? args.command ?? ''),
        outcome: 'denied',
        resultSummary: '未绑定 Workspace',
      })
      return `好友「${ctx.friend.name}」还没有绑定 Workspace，请先在设置里选择本机目录。聊天仍可用，但编码工具已禁用。`
    }
    await ensureWorkspaceRoot(ctx.friend.workspacePath ?? '')

    if (name === 'workbench_fs_list') {
      const result = await listWorkspace(ctx.friend, stringArg(args, 'path') || '.')
      await ctx.actions.recordTimeline({
        conversationId: ctx.conversationId,
        friendId: ctx.friend.id,
        runId: ctx.runId,
        toolName: name,
        detail: result.rootRelative,
        outcome: 'ok',
        resultSummary: `${result.entries.length} 项`,
      })
      return JSON.stringify(result, null, 2)
    }

    if (name === 'workbench_fs_read') {
      const filePath = stringArg(args, 'path')
      if (!filePath) return '缺少 path。'
      const result = await readWorkspaceFile(ctx.friend, filePath)
      await ctx.actions.recordTimeline({
        conversationId: ctx.conversationId,
        friendId: ctx.friend.id,
        runId: ctx.runId,
        toolName: name,
        detail: result.relativePath,
        outcome: 'ok',
        resultSummary: result.truncated ? '已截断' : `${result.content.length} 字符`,
      })
      return JSON.stringify(result, null, 2)
    }

    if (name === 'workbench_fs_grep') {
      const pattern = stringArg(args, 'pattern')
      if (!pattern) return '缺少 pattern。'
      const result = await grepWorkspace(
        ctx.friend,
        pattern,
        stringArg(args, 'path') || '.',
        stringArg(args, 'glob') || undefined,
      )
      await ctx.actions.recordTimeline({
        conversationId: ctx.conversationId,
        friendId: ctx.friend.id,
        runId: ctx.runId,
        toolName: name,
        detail: pattern,
        outcome: 'ok',
        resultSummary: `${result.hits.length} 命中 / ${result.scannedFiles} 文件`,
      })
      return JSON.stringify(result, null, 2)
    }

    if (!canWriteOrShell(ctx.friend)) {
      await ctx.actions.recordTimeline({
        conversationId: ctx.conversationId,
        friendId: ctx.friend.id,
        runId: ctx.runId,
        toolName: name,
        detail: String(args.path ?? args.command ?? ''),
        outcome: 'denied',
        resultSummary: '只读权限',
      })
      return '当前权限为只读，不能改文件或执行命令。'
    }

    if (name === 'workbench_fs_write') {
      const filePath = stringArg(args, 'path')
      const content = typeof args.content === 'string' ? args.content : ''
      if (!filePath) return '缺少 path。'
      const action = await ctx.actions.stageWrite({
        conversationId: ctx.conversationId,
        friend: ctx.friend,
        relativePath: filePath,
        content,
        runId: ctx.runId,
        unifiedDiff: stringArg(args, 'unifiedDiff') || undefined,
      })
      if (runsImmediately(ctx, 'file')) {
        const confirmed = await ctx.actions.confirm(action.id)
        const saved = (confirmed.result ?? {}) as { relativePath?: string; bytes?: number }
        return `已写入 ${saved.relativePath ?? filePath}（${saved.bytes ?? Buffer.byteLength(content, 'utf8')} 字节，${immediateReason(ctx)}）。`
      }
      return `已出示写入确认卡（id=${action.id}），用户确认前磁盘不会改变。请勿声称已经保存。摘要：${action.summary}`
    }

    if (name === 'workbench_fs_delete') {
      const filePath = stringArg(args, 'path')
      if (!filePath) return '缺少 path。'
      const action = await ctx.actions.stageDelete({
        conversationId: ctx.conversationId,
        friend: ctx.friend,
        relativePath: filePath,
        runId: ctx.runId,
      })
      if (runsImmediately(ctx, 'file')) {
        const confirmed = await ctx.actions.confirm(action.id)
        const saved = (confirmed.result ?? {}) as { relativePath?: string }
        return `已删除 ${saved.relativePath ?? filePath}（${immediateReason(ctx)}）。`
      }
      return `已出示删除确认卡（id=${action.id}），用户确认前不会删除。请勿声称已经删掉。摘要：${action.summary}`
    }

    if (name === 'workbench_shell') {
      const command = stringArg(args, 'command')
      if (!command) return '缺少 command。'
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
      const action = await ctx.actions.stageShell({
        conversationId: ctx.conversationId,
        friend: ctx.friend,
        command,
        runId: ctx.runId,
        timeoutMs,
      })
      if (runsImmediately(ctx, 'shell')) {
        const confirmed = await ctx.actions.confirm(action.id)
        const result = (confirmed.result ?? {}) as {
          exitCode?: number
          stdoutTail?: string
          stderrTail?: string
          timedOut?: boolean
        }
        const output = [result.stdoutTail, result.stderrTail].filter(Boolean).join('\n').trim()
        return [
          `已执行命令（${immediateReason(ctx)}）`,
          `退出码：${result.exitCode ?? '?'}${result.timedOut ? ' · 超时' : ''}`,
          output ? `输出：\n${output.slice(-4000)}` : '输出：（无输出）',
        ].join('\n')
      }
      return `已出示命令确认卡（id=${action.id}），用户批准前不会执行。请勿声称已经跑完。命令：${command}`
    }

    return `未知编码工具：${name}`
  } catch (error) {
    const message = error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error)
    await ctx.actions.recordTimeline({
      conversationId: ctx.conversationId,
      friendId: ctx.friend.id,
      runId: ctx.runId,
      toolName: name,
      detail: String(args.path ?? args.command ?? ''),
      outcome: 'error',
      resultSummary: message,
    }).catch(() => undefined)
    return message
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 写/删在群目录里也直接落盘；shell 只有无人值守或危险全开才跳过确认。 */
function runsImmediately(ctx: CodeToolContext, kind: 'file' | 'shell'): boolean {
  if (ctx.autoConfirm || executesWithoutConfirm(ctx.friend)) return true
  return kind === 'file' && Boolean(ctx.autoFileOps)
}

function immediateReason(ctx: CodeToolContext): string {
  if (ctx.autoConfirm) return '无人值守自动确认，无需用户确认'
  if (executesWithoutConfirm(ctx.friend)) return '危险全开，无需确认'
  return '群工作空间直接执行，无需确认'
}
