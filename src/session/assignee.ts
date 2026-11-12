/**
 * 登记在册的好友被群主指派后，按 harness 式「开发回流」执行：
 * 模型调工具 → 工具结果回流 → 继续下一步，直到收口；有工作目录才会拿到读写/shell 工具。
 * 被指派的人没有本群之前的对话和记忆，只看到群主写好的这条任务。
 * 没绑工作目录时不假装执行，只出方案；模型把工具调用写成 DSML 文本时重新收口并隐藏原始标记。
 */

import type { Assignment, Conversation, Friend, Provider } from '../domain/types.ts'
import type { McpChatTarget } from '../app/mcp.ts'
import type { OpenAiTool, ToolCatalog } from '../mcp/hub.ts'
import type { Repos } from '../storage/repos/index.ts'
import type { ChatMessage } from '../llm/client.ts'
import { chat } from '../llm/client.ts'
import { hasToolMarkup, sanitizeAssignmentText } from '../llm/tool-markup.ts'
import { log } from '../logger.ts'
import { presentCodeTools } from '../app/code-tools.ts'
import { ensureWorkspaceRoot, executesWithoutConfirm, friendInWorkspace, resolveMemberWorkspace } from '../app/code-workspace.ts'
import { groupMemberSystemPrompt, workspaceDirectoryPrompt } from '../domain/group-workspace.ts'
import { AppError } from '../app/errors.ts'
import { assertProviderReady } from '../app/providers.ts'
import { humanizeTurnError } from './orchestrator.ts'
import { runAssistantTurn } from './tool-loop.ts'

export type AssigneeRunInput = {
  assignment: Assignment
  friend: Friend
  conversation: Conversation
  signal: AbortSignal
  onProgress?: (text: string) => Promise<void>
}

export type AssigneeRunResult = {
  content: string
  /** 实际执行的工具步数（工具调用次数）。 */
  steps: number
}

export type AssigneeRunner = (input: AssigneeRunInput) => Promise<AssigneeRunResult>

export type AssigneeRunnerOptions = {
  repos: Repos
  resolveApiKey?: (provider: Provider) => Promise<string | undefined>
  /** 已启用、且对当前群和被指派好友可见的 MCP 工具；连不上由调用方兜底。 */
  mcpCatalog?: (target: McpChatTarget) => Promise<ToolCatalog>
  codeTools?: {
    tools: OpenAiTool[]
    isBound: (friend: Friend) => boolean
    call: (
      name: string,
      args: string,
      ctx: { friend: Friend; conversationId: string; runId?: string; autoFileOps?: boolean },
    ) => Promise<string>
  }
  fetchImpl?: typeof fetch
}

export function createAssigneeRunner(options: AssigneeRunnerOptions): AssigneeRunner {
  const fetchImpl = options.fetchImpl ?? fetch

  return async function runAssignee(input) {
    const { assignment, friend, conversation, signal } = input
    const report = async (text: string) => {
      try {
        await input.onProgress?.(text)
      } catch (error) {
        log('warn', 'assignments', '指派进度没有写入', {
          id: assignment.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const provider = await options.repos.providers.get(friend.providerId)
    if (!provider) throw new AppError(400, '指派的好友没有可用的提供方，结果没有写回群里。')
    assertProviderReady(provider)
    const model = (friend.defaultModelId || provider.defaultModel || '').trim()
    if (!model) throw new AppError(400, '这位好友还没有默认模型，结果没有写回群里。')

    let catalog: ToolCatalog = { tools: [], call: async () => '' }
    if (options.mcpCatalog) {
      try {
        catalog = await options.mcpCatalog({
          kind: conversation.kind,
          speakerFriendId: friend.id,
          lineageId: conversation.lineageId || conversation.id,
        })
      } catch (error) {
        log('warn', 'assignments', 'MCP 工具准备失败，本次只带编码工具', {
          id: assignment.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const workspace = resolveMemberWorkspace(conversation, friend)
    const acting = friendInWorkspace(friend, workspace)
    if (workspace.autoFileOps && workspace.root) await ensureWorkspaceRoot(workspace.root)
    const codeTools = options.codeTools
    const codeBound = Boolean(codeTools && acting.workspacePath?.trim() && codeTools.isBound(acting))
    const tools: OpenAiTool[] = [
      ...catalog.tools,
      ...(codeBound && codeTools ? presentCodeTools(codeTools.tools, acting) : []),
    ]
    const codeToolNames = new Set(codeTools?.tools.map((tool) => tool.function.name) ?? [])

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(acting, codeBound, workspace.autoFileOps, groupMemberSystemPrompt(conversation, friend)) },
    ]
    chatMessages.push({
      role: 'user',
      content: [
        `群主指派给你的任务：\n${assignment.instruction}`,
        '',
        '现在开始执行。工具结果会回流给你；请据此继续下一步，完成后按「做了什么 / 改了哪些文件 / 怎么验证 / 还缺什么」收口。',
      ].join('\n'),
    })

    const apiKey = options.resolveApiKey ? await options.resolveApiKey(provider) : undefined
    let steps = 0
    let content = ''

    try {
      if (tools.length === 0) {
        await report(codeBound ? '正在整理结果…' : '未绑定工作目录，正在整理可执行方案…')
        const result = await chat({
          baseUrl: provider.baseUrl,
          apiKey,
          model,
          messages: chatMessages,
          signal,
        }, fetchImpl)
        content = result.content
      } else {
        await report('正在读任务与工作区…')
        const turn = await runAssistantTurn({
          baseUrl: provider.baseUrl,
          apiKey,
          model,
          messages: chatMessages,
          signal,
          tools,
          maxRounds: 8,
          fetchImpl,
          callTool: async (name, args, toolSignal) => {
            steps += 1
            await report(`正在调用 ${name}…（第 ${steps} 步）`)
            if (codeBound && codeTools && codeToolNames.has(name)) {
              return codeTools.call(name, args, {
                friend: acting,
                conversationId: conversation.id,
                ...(workspace.autoFileOps ? { autoFileOps: true } : {}),
              })
            }
            return catalog.call(name, args, toolSignal)
          },
          onProgress: async (state) => {
            const text = state.content.trim()
            if (!text) return
            await report(text.startsWith('正在调用工具') ? `${text}…` : '正在整理结果…')
          },
        })
        content = turn.content
      }

      if (hasToolMarkup(content)) {
        log('warn', 'assignments', '模型输出未执行的工具调用文本，正在重新收口', {
          id: assignment.id,
          steps,
        })
        await report('工具调用没有执行，正在重新收口…')
        try {
          const retried = await chat({
            baseUrl: provider.baseUrl,
            apiKey,
            model,
            messages: [
              ...chatMessages,
              { role: 'assistant', content },
              {
                role: 'user',
                content:
                  '你上一条回复把工具调用写成了普通文本，系统没有执行。不要重复输出 <|DSML|>、invoke、parameter 这类标记。请直接用自然语言收口：已确认的事实、建议的下一步、需要用户绑定工作目录或确认的事项。',
              },
            ],
            signal,
          }, fetchImpl)
          if (retried.content.trim() && !hasToolMarkup(retried.content)) content = retried.content
        } catch (error) {
          log('warn', 'assignments', '重新收口失败，改用已产出的文本', {
            id: assignment.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const finalText = sanitizeAssignmentText(content) || '完成'
      if (steps > 0) await report(`已执行 ${steps} 步，正在收口…`)
      return { content: finalText, steps }
    } catch (error) {
      if (signal.aborted) throw error
      throw new Error(humanizeTurnError(error))
    }
  }
}

function buildSystemPrompt(friend: Friend, codeBound: boolean, autoFileOps = false, persona = ''): string {
  const lines: string[] = []
  const prompt = persona.trim()
  if (prompt) lines.push(prompt)
  const directory = friend.workspacePath?.trim() ? workspaceDirectoryPrompt(friend.workspacePath) : ''
  if (directory) lines.push(directory)
  lines.push(
    '你没有本群之前的对话、会话摘要或长期记忆。只执行下面这条群主写好的任务，不要假设自己知道更早的讨论。',
  )
  lines.push(
    [
      '',
      '你按 harness 式「开发回流」方式工作：',
      '1. 先读代码/文件，列出 2–4 步计划，再动手；',
      '2. 每一步用工具推进，工具结果回流后马上判断下一步，不要停在“打算做”；',
      '3. 读完的信息足够支持改动时，直接调用写文件/命令工具继续，不要用「下一步：…」结尾就停；只有需要用户确认、缺少工作目录或确实无法继续时才收口；',
      '4. 最后用一小段收口：做了什么、改了哪些文件、怎么验证、还缺什么。',
      '不要输出 <|DSML|>、Bash、invoke、parameter 这类原始工具标记；要调用工具就用提供的 function tools。',
    ].join('\n'),
  )
  if (codeBound && executesWithoutConfirm(friend)) {
    lines.push(
      [
        '',
        '可用工具：workbench_fs_list / workbench_fs_read / workbench_fs_grep 用于探索；workbench_fs_write 改文件；workbench_fs_delete 删除文件或空目录；workbench_shell 跑命令。',
        '当前是危险全开：写文件、删除和跑命令都会直接执行并返回结果，不再出确认卡。路径必须落在你的工作目录内。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径，这类命令会被拒绝。按实际结果收口，不要说还在等确认。声称核对过目录之前，必须先有 workbench_fs_list 或 workbench_fs_grep 的返回。',
      ].join('\n'),
    )
  } else if (codeBound && autoFileOps) {
    lines.push(
      [
        '',
        '可用工具：workbench_fs_list / workbench_fs_read / workbench_fs_grep 用于探索；workbench_fs_write 改文件；workbench_fs_delete 删除文件或空目录；workbench_shell 跑命令。',
        '写文件和删除会直接执行，不必等确认。跑命令仍先出示确认卡，批准前不要声称已经执行。路径必须落在你的工作目录内。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称核对过目录之前，必须先有 workbench_fs_list 或 workbench_fs_grep 的返回。',
      ].join('\n'),
    )
  } else if (codeBound) {
    lines.push(
      [
        '',
        '可用工具：workbench_fs_list / workbench_fs_read / workbench_fs_grep 用于探索；workbench_fs_write 改文件；workbench_fs_delete 删除文件或空目录；workbench_shell 跑命令。',
        '写文件、删除和跑命令会先出示确认卡，用户确认前磁盘不会变；确认前不要声称已经写入、删除或执行。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称核对过目录之前，必须先有 workbench_fs_list 或 workbench_fs_grep 的返回。',
      ].join('\n'),
    )
  } else if (directory) {
    lines.push('这次没有编码工具。不要声称已经读写过你的工作目录里的文件。')
  } else {
    lines.push(
      [
        '',
        '你没有绑定工作目录：不能读写本机文件，也不能跑命令。',
        '不要假装执行过命令或改过文件。请直接给出可执行的改造方案、涉及文件和验证步骤，并请用户先在好友资料里绑定工作目录再指派。',
      ].join('\n'),
    )
  }
  return lines.join('\n')
}
