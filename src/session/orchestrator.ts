/**
 * 发送编排：先落下用户消息和 pending run，等 SEND_DELAY_MS 再调模型。
 * 等待期间和流式输出期间都可以 cancelRun。取消会中止请求、删掉这条用户消息，
 * 把原文交还输入框，并且不写摘要。
 */

import type { Friend, MemoryInject, Message, MessageAttachment, Run } from '../domain/types.ts'
import { findMention, handoffMention } from '../domain/mentions.ts'
import { presentCodeTools } from '../app/code-tools.ts'
import { ensureWorkspaceRoot, executesWithoutConfirm, friendInWorkspace, resolveMemberWorkspace } from '../app/code-workspace.ts'
import { groupMemberSystemPrompt, workspaceDirectoryPrompt } from '../domain/group-workspace.ts'
import { AppError } from '../app/errors.ts'
import { assertProviderReady } from '../app/providers.ts'
import type { ChatContent, ChatContentPart, ChatMessage } from '../llm/client.ts'
import type { McpChatTarget } from '../app/mcp.ts'
import type { OpenAiTool, ToolCatalog } from '../mcp/hub.ts'
import { CLARIFY_TOOL } from '../app/clarify.ts'
import { parsePlanFromAssistant, stripClarifyFromBody, stripPlanConfirmAsk } from '../app/plan-mode.ts'
import { CONFIG_GET_TOOL, PROPOSE_TOOL } from '../app/proposals.ts'
import { LlmError } from '../llm/errors.ts'
import { persistTurnMemory } from '../memory/commit.ts'
import { recall } from '../memory/recall.ts'
import { buildMemoryInject } from '../memory/inject.ts'
import { formatLongTermMemorySystemPrompt } from '../app/long-term-memory.ts'
import { detectSkillSuggestion } from '../app/skill-suggestions.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { findExistingRun } from './dedup.ts'
import { buildIdempotencyKey, TurnQueue } from './queue.ts'
import { runAssistantTurn } from './tool-loop.ts'

/** 默认等 5 秒再打模型，给取消留出窗口。可用环境变量 SEND_DELAY_MS 覆盖。 */
export const DEFAULT_SEND_DELAY_MS = 5000

export type SendTurnInput = {
  conversationId: string
  text: string
  /** 已上传附件；无则纯文字路径不变。 */
  attachments?: MessageAttachment[]
  clientTurnId?: string
  model?: string
  /** 聊天菜单临时换提供方；不传则用好友/会话绑定。 */
  providerId?: string
  /** 单次覆盖，测试用。不传则用编排器上的 delayMs。 */
  delayMs?: number
  /** 仅内部邮件任务：额外的无人值守工作提示词。 */
  extraSystemPrompt?: string
  /** 仅内部邮件任务：写文件 / shell 直接执行，不走确认气泡。 */
  autoConfirmCode?: boolean
  /**
   * 仅内部邮件任务。正文是纯文本工作指令，不因目标会话里以前的图片改走视觉模型。
   */
  skipVision?: boolean
}

export type SendTurnResult = {
  run: Run
  message: Message
  delayMs: number
}

export type CancelRunResult = {
  run: Run
  draftText: string
}

type LiveTurn = {
  runId: string
  conversationId: string
  draftText: string
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  cancelled: boolean
  extraSystemPrompt?: string
  autoConfirmCode?: boolean
  visionActive?: boolean
}

export type RememberTurn = (repos: Repos, run: Run) => Promise<void>

export type OrchestratorOptions = {
  repos: Repos
  /** 宿主固定覆盖（测试常用 sendDelayMs:0）。有值时优先于全局设置。 */
  delayMs?: number
  /** 读全局「发送后等待秒数」×1000；无 delayMs/env 时使用。 */
  resolveSettingsDelayMs?: () => Promise<number>
  fetchImpl?: typeof fetch
  remember?: RememberTurn
  resolveApiKey?: (provider: import('../domain/types.ts').Provider) => Promise<string | undefined>
  /** 已启用、且对当前会话和发言人可见的 MCP 工具。连不上时由实现方自己跳过。 */
  mcpCatalog?: (target: McpChatTarget) => Promise<ToolCatalog>
  /** 把模型的创建提议收成确认卡。返回给模型看的说明，不要说已经保存。 */
  propose?: (conversationId: string, args: Record<string, unknown>) => Promise<string>
  /** p1.4：只读配置摘要，改之前先 get 再 propose。 */
  getConfig?: (args: Record<string, unknown>) => Promise<string>
  /** 计划模式：把不明确处收成澄清卡。返回给模型的说明里不要复述选项。 */
  clarify?: (conversationId: string, runId: string, args: Record<string, unknown>) => Promise<string>
  /**
   * 计划模式回合结束后，用助手 Markdown 落真实计划。
   * 失败只记日志，不影响这条已完成的回复。
   */
  onPlanAssistant?: (input: { conversationId: string; content: string; friendId?: string }) => Promise<void>
  /**
   * p1.1：好友已绑 Workspace 时注入编码工具。
   * 未绑定不注入；写/shell 由 call 内 stage，确认前不落盘。
   */
  codeTools?: {
    tools: OpenAiTool[]
    isBound: (friend: import('../domain/types.ts').Friend) => boolean
    call: (
      name: string,
      args: string,
      ctx: {
        friend: import('../domain/types.ts').Friend
        conversationId: string
        runId?: string
        autoConfirm?: boolean
        /** 群工作空间：写和删直接执行，shell 仍确认。 */
        autoFileOps?: boolean
      },
    ) => Promise<string>
  }
  /** 视觉插件：按附件 id 读出图片字节；拿不到就当普通附件标签。 */
  loadImage?: (
    attachment: MessageAttachment,
  ) => Promise<{ mime: string; data: Uint8Array } | null>
  /**
   * p1.2：计划模式系统提示。从全局设置读取（可编辑），勿写死常量。
   * 返回已替换 {{planPath}} 的文案；非计划模式可不提供。
   */
  resolvePlanModePrompt?: (ctx: {
    conversationId: string
    activePlanId?: string
  }) => Promise<string | undefined>
  /**
   * 群聊里群主在回复中用 @好友 交办：把任务转给那位好友（通常创建一条指派）。
   * 失败只记日志，不影响群主这条已完成的回复。
   */
  onGroupHandoff?: (input: {
    conversationId: string
    fromFriendId: string
    toFriendId: string
    instruction: string
    runId: string
  }) => Promise<void>
}

/**
 * 解析本次发送要等多久。
 * 优先级：请求/宿主 override → 环境变量 SEND_DELAY_MS → fallback（全局设置秒数×1000 或默认 5000）。
 */
export function resolveSendDelayMs(override?: number, fallback = DEFAULT_SEND_DELAY_MS): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < 0 || override > 60_000) {
      throw new AppError(400, 'delayMs 需要是 0 到 60000 之间的数')
    }
    return override
  }
  const raw = process.env.SEND_DELAY_MS
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

/** 一个进程里的发送编排器。AbortSignal 只活在内存里。 */
export function createOrchestrator(options: OrchestratorOptions) {
  const repos = options.repos
  const fetchImpl = options.fetchImpl ?? fetch
  const remember = options.remember ?? persistTurnMemory
  const resolveApiKey = options.resolveApiKey ?? (async () => undefined)
  const queue = new TurnQueue()
  const live = new Map<string, LiveTurn>()
  const chains = new Map<string, Promise<void>>()

  async function delayOf(override?: number): Promise<number> {
    if (override !== undefined) return resolveSendDelayMs(override)
    if (options.delayMs !== undefined) return resolveSendDelayMs(options.delayMs)
    const settingsMs = options.resolveSettingsDelayMs
      ? await options.resolveSettingsDelayMs()
      : DEFAULT_SEND_DELAY_MS
    return resolveSendDelayMs(undefined, settingsMs)
  }

  /** 同一个 run 的取消和收尾串行，避免一边删除消息一边写成完成。 */
  function critical<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(runId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    chains.set(
      runId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  async function sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const text = input.text.trim()
    const attachments = input.attachments?.length ? input.attachments : undefined
    if (!text && !attachments) throw new AppError(400, '消息不能为空。')
    const conversation = await repos.conversations.get(input.conversationId)
    if (!conversation) throw new AppError(404, '找不到这个会话')
    if (conversation.kind === 'group' && conversation.archived) {
      throw new AppError(400, '这个群已归档，取消归档后才能继续聊天。')
    }
    const friends = await repos.friends.list()
    const members = conversation.friendIds
      .map((id) => friends.find((friend) => friend.id === id))
      .filter((friend): friend is Friend => Boolean(friend))
    // 群聊不 @ 时默认由群主接；没有群主的旧群回退到会话首位。
    const groupOwner = conversation.kind === 'group' ? members.find((friend) => friend.isOwnerTemplate) : undefined
    const primarySpeaker = groupOwner ?? friends.find((friend) => friend.id === conversation.friendIds[0])
    // 群聊里 @ 了非群主好友：这一回合直接由 TA 接，群主不介入。
    const mention = conversation.kind === 'group' ? findMention(text, members) : null
    const directTarget = mention && mention.friend.id !== primarySpeaker?.id ? mention.friend : null
    const speaker = directTarget ?? primarySpeaker
    const providers = await repos.providers.list()
    // 视觉插件：本条或最近消息里有图片才切到视觉模型；图片随后在 startModel 里内联。
    // 邮件任务是纯文本指令，不因会话里的旧图改道。视觉提供方停用时，没带新图的文本回合退回聊天模型。
    const recentMessages = await repos.messages.listByConversation(conversation.id)
    const currentHasImage = Boolean(attachments?.some((item) => item.kind === 'image'))
    const hasRecentImage =
      currentHasImage ||
      recentMessages.slice(-8).some((item) => item.attachments?.some((att) => att.kind === 'image'))
    const groupMemberModel =
      conversation.kind === 'group' && speaker ? conversation.memberModels?.[speaker.id] : undefined
    const chatProviderId = (
      conversation.kind === 'group'
        ? groupMemberModel?.providerId || speaker?.providerId || conversation.providerId
        : input.providerId || speaker?.providerId || conversation.providerId
    ).trim()
    let vision = input.skipVision || !speaker?.vision?.enabled || !hasRecentImage ? undefined : speaker.vision
    let providerId = (vision?.providerId || chatProviderId).trim()
    let provider = providers.find((item) => item.id === providerId)
    if (vision && (!provider || !provider.enabled)) {
      if (currentHasImage) {
        if (!provider) throw new AppError(400, '找不到可用的模型提供方。请到设置里检查。')
        assertProviderReady(provider)
      }
      log('warn', 'session', '视觉提供方不可用，文本回合改用聊天模型', {
        conversationId: conversation.id,
        providerId: vision.providerId,
      })
      vision = undefined
      providerId = chatProviderId
      provider = providers.find((item) => item.id === providerId)
    }
    if (!provider) throw new AppError(400, '找不到可用的模型提供方。请到设置里检查。')
    assertProviderReady(provider)
    // 群聊按发言人取本群覆盖，没有则用好友自己的模型，不改好友资料。
    // 单聊仍允许请求里带上临时模型。视觉回合用插件配置的模型。
    const modelFallback = directTarget
      ? provider.defaultModel || conversation.model
      : conversation.model || provider.defaultModel
    const model = (
      vision
        ? vision.modelId || groupMemberModel?.model || speaker?.defaultModelId || provider.defaultModel || conversation.model || ''
        : conversation.kind === 'group'
          ? groupMemberModel?.model || speaker?.defaultModelId || provider.defaultModel || ''
          : input.model || speaker?.defaultModelId || modelFallback || ''
    ).trim()
    if (!model) {
      throw new AppError(
        400,
        vision ? '视觉插件还没有可用模型。请在好友设置里填一个支持图片输入的模型。' : conversation.kind === 'group'
          ? '这位好友还没有可用模型。可以在群设置里单独指定，没指定时用好友自己的模型。'
          : '还没有指定模型。请在顶栏点模型，选一个探测到的模型后再发送。',
      )
    }

    const active = (await repos.runs.listByConversation(conversation.id)).find(
      (item) => item.status === 'pending' || item.status === 'running',
    )
    if (active) throw new AppError(409, '上一条还在发送，可以先取消。')

    const clientTurnId = input.clientTurnId ?? crypto.randomUUID()
    const idempotencyKey = buildIdempotencyKey(conversation.id, clientTurnId)
    const existing = await findExistingRun(repos, idempotencyKey)
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'running') {
        const message = existing.messageId
          ? (await repos.messages.listByConversation(conversation.id)).find((item) => item.id === existing.messageId)
          : undefined
        if (!message) throw new AppError(409, '这个回合已经提交过')
        return { run: existing, message, delayMs: await delayOf(input.delayMs) }
      }
      throw new AppError(409, '这个回合已经提交过')
    }

    const queued = queue.enqueue({
      id: clientTurnId,
      conversationId: conversation.id,
      idempotencyKey,
    })
    if (!queued.accepted) throw new AppError(409, '这个回合已经在队列里')

    const now = Date.now()
    const messageId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const message: Message = {
      id: messageId,
      conversationId: conversation.id,
      role: 'user',
      content: text,
      status: 'pending',
      runId,
      ...(attachments ? { attachments } : {}),
      createdAt: now,
    }
    const run: Run = {
      id: runId,
      conversationId: conversation.id,
      messageId,
      status: 'pending',
      idempotencyKey,
      providerId: provider.id,
      model,
      ...(speaker ? { speakerFriendId: speaker.id } : {}),
      ...(vision ? { vision: true } : {}),
      draftText: text,
      createdAt: now,
    }
    await repos.messages.put(message)
    await repos.runs.put(run)
    try {
      await detectSkillSuggestion(repos, conversation.id)
    } catch (error) {
      log('warn', 'skill-suggest', '检测重复模式失败', {
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // 群聊模型按成员解析，不写回会话级 model，也不改好友资料。
    if (conversation.kind !== 'group' && !directTarget && !vision && conversation.model !== model) {
      await repos.conversations.put({ ...conversation, model, updatedAt: now })
    } else {
      await repos.conversations.put({ ...conversation, updatedAt: now })
    }

    const delayMs = await delayOf(input.delayMs)
    const controller = new AbortController()
    const entry: LiveTurn = {
      runId,
      conversationId: conversation.id,
      draftText: text,
      controller,
      cancelled: false,
      ...(input.extraSystemPrompt?.trim() ? { extraSystemPrompt: input.extraSystemPrompt.trim() } : {}),
      ...(input.autoConfirmCode ? { autoConfirmCode: true } : {}),
      ...(vision ? { visionActive: true } : {}),
    }
    entry.timer = setTimeout(() => {
      void startModel(runId)
    }, delayMs)
    live.set(runId, entry)
    log('info', 'session', '发送已排队', {
      conversationId: conversation.id,
      runId,
      delayMs,
    })
    return { run, message, delayMs }
  }

  async function startModel(runId: string): Promise<void> {
    const entry = live.get(runId)
    if (!entry || entry.cancelled || entry.controller.signal.aborted) return
    const proceed = await critical(runId, async () => {
      if (entry.cancelled) return false
      const current = await repos.runs.get(runId)
      if (!current || current.status !== 'pending') return false
      await repos.runs.put({ ...current, status: 'running', startedAt: Date.now() })
      log('info', 'session', '延迟结束，开始生成', { conversationId: entry.conversationId, runId })
      return true
    })
    if (!proceed) return

    let assistantId: string | undefined
    try {
      const history = await repos.messages.listByConversation(entry.conversationId)
      const conversation = await repos.conversations.get(entry.conversationId)
      const friends = await repos.friends.list()
      const run = await repos.runs.get(runId)
      if (!run) return
      // 群聊 @ 点名时 run 上记了实际接话的好友；没点名默认由群主接，老 run 回退到会话首位。
      const members =
        conversation?.kind === 'group'
          ? conversation.friendIds
              .map((id) => friends.find((friend) => friend.id === id))
              .filter((friend): friend is Friend => Boolean(friend))
          : []
      const fallbackSpeakerId =
        conversation?.kind === 'group'
          ? members.find((friend) => friend.isOwnerTemplate)?.id ?? conversation.friendIds[0]
          : conversation?.friendIds[0]
      const speakerId = run.speakerFriendId ?? fallbackSpeakerId
      const speaker = friends.find((friend) => friend.id === speakerId)
      // 群里只有群主带着摘要、长期记忆和更早的对话。其他成员只看当前这一条任务。
      const statelessMember = Boolean(conversation?.kind === 'group' && speaker && !speaker.isOwnerTemplate)
      const turnHistory = statelessMember ? history.filter((item) => item.id === run.messageId) : history
      const imageUrls = new Map<string, string>()
      if (entry.visionActive && options.loadImage) {
        const attachments: MessageAttachment[] = []
        for (let index = turnHistory.length - 1; index >= 0 && attachments.length < 4; index -= 1) {
          const message = turnHistory[index]
          if (!message || message.role !== 'user') continue
          for (const attachment of [...(message.attachments ?? [])].reverse()) {
            if (attachment.kind !== 'image' || attachments.some((item) => item.id === attachment.id)) continue
            attachments.push(attachment)
            if (attachments.length >= 4) break
          }
        }
        let totalBytes = 0
        for (const attachment of attachments) {
          try {
            const loaded = await options.loadImage(attachment)
            if (!loaded || loaded.data.byteLength > 4 * 1024 * 1024) continue
            if (totalBytes + loaded.data.byteLength > 8 * 1024 * 1024) continue
            totalBytes += loaded.data.byteLength
            imageUrls.set(
              attachment.id,
              `data:${loaded.mime};base64,${Buffer.from(loaded.data).toString('base64')}`,
            )
          } catch (error) {
            log('warn', 'session', '读取图片失败，按文本标签处理', {
              conversationId: entry.conversationId,
              runId,
              attachmentId: attachment.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      const chatMessages: ChatMessage[] = []
      const persona = speaker ? groupMemberSystemPrompt(conversation, speaker) : ''
      if (persona) chatMessages.push({ role: 'system', content: persona })
      if (entry.extraSystemPrompt) chatMessages.push({ role: 'system', content: entry.extraSystemPrompt })
      if (members.length > 0 && conversation) {
        chatMessages.push({ role: 'system', content: buildGroupMentionPrompt(members, speaker, conversation) })
      }
      const workspace = speaker ? resolveMemberWorkspace(conversation, speaker) : null
      const actingFriend = speaker && workspace ? friendInWorkspace(speaker, workspace) : speaker
      if (workspace?.autoFileOps && workspace.root) await ensureWorkspaceRoot(workspace.root)
      const memory = statelessMember ? null : await recall(repos, entry.conversationId, 1)
      let memoryInject: MemoryInject | undefined
      if (statelessMember) {
        log('info', 'memory', '群成员无历史记忆，本回合只带当前任务', {
          conversationId: entry.conversationId,
          runId,
          speakerFriendId: speaker?.id,
        })
      } else if (conversation && memory) {
        const built = await buildMemoryInject(repos, conversation, history, memory.summary)
        memoryInject = built.inject
        if (memoryInject.summary && memory.summary?.content.trim()) {
          chatMessages.push({
            role: 'system',
            content: `以下是这段会话已写入记忆的摘要。后续回答沿用它，不要要求用户重复背景。\n${memory.summary.content}`,
          })
          log('info', 'memory', '摘要已注入本回合', {
            conversationId: entry.conversationId,
            runId,
            summaryId: memory.summary.id,
          })
        }
        const ltmPrompt = formatLongTermMemorySystemPrompt(built.ltmMemories)
        if (ltmPrompt) {
          chatMessages.push({ role: 'system', content: ltmPrompt })
          log('info', 'ltm', '长期记忆已注入本回合', {
            conversationId: entry.conversationId,
            runId,
            count: built.ltmMemories.length,
            friendCount: memoryInject.ltmFriendCount,
            projectCount: memoryInject.ltmProjectCount,
          })
        }
      }
      chatMessages.push({
        role: 'system',
        content: '若要新建技能、MCP、任务、好友，或改提供方/应用设置/好友资料/群/保险库绑定，先可调用 workbench_get_config 读摘要，再调用 workbench_propose 出示确认卡。用户确认前不要说已经保存。密钥不要复述明文。',
      })
      const directoryPrompt = workspace?.root ? workspaceDirectoryPrompt(workspace.root) : ''
      if (directoryPrompt) chatMessages.push({ role: 'system', content: directoryPrompt })
      if (actingFriend && options.codeTools?.isBound(actingFriend)) {
        chatMessages.push({
          role: 'system',
          content: entry.autoConfirmCode
            ? '好友已绑定本机 Workspace。当前是无人值守任务：workbench_fs_write / workbench_fs_delete / workbench_shell 会直接执行并返回结果，不再出确认卡。仍只能操作你的工作目录内路径；先读再改，最后报告结果。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称已经核对过目录之前，必须先调用 workbench_fs_list 或 workbench_fs_grep。'
            : executesWithoutConfirm(actingFriend)
              ? '好友已绑定本机 Workspace。当前是危险全开：workbench_fs_write / workbench_fs_delete / workbench_shell 会直接执行并返回结果，不再出确认卡。仍只能操作你的工作目录内路径；先读再改，最后按实际结果报告，不要说还在等确认。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称已经核对过目录之前，必须先调用 workbench_fs_list 或 workbench_fs_grep。'
              : workspace?.autoFileOps
                ? '写文件和删除会直接执行，不必等确认。workbench_shell 仍只出示确认卡，批准前不要声称已经执行。只能操作你的工作目录内的路径。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称已经核对过目录之前，必须先调用 workbench_fs_list 或 workbench_fs_grep。'
                : '好友已绑定本机 Workspace。可用 workbench_fs_list / workbench_fs_read / workbench_fs_grep 只读探索；改文件用 workbench_fs_write、删除用 workbench_fs_delete、跑命令用 workbench_shell——后三者只出示确认卡，用户确认前不要说已经写入、删除或执行。路径必须落在你的工作目录内，越界会被拒绝。workbench_shell 不能使用 ..、~ 或工作目录以外的绝对路径。声称已经核对过目录之前，必须先调用 workbench_fs_list 或 workbench_fs_grep。',
        })
      }
      const planTurn = Boolean(!statelessMember && conversation?.chatMode === 'plan' && !entry.autoConfirmCode)
      if (planTurn && options.resolvePlanModePrompt) {
        const planPrompt = await options.resolvePlanModePrompt({
          conversationId: entry.conversationId,
          activePlanId: conversation?.activePlanId,
        })
        if (planPrompt?.trim()) {
          chatMessages.push({ role: 'system', content: planPrompt.trim() })
          log('info', 'plan', '计划模式提示已注入', { conversationId: entry.conversationId, runId })
        }
      }
      if (planTurn && options.clarify) {
        chatMessages.push({
          role: 'system',
          content:
            '不明确处调用 workbench_clarify 出示澄清卡（一句问题 + 可点选项），不要把选择题或序号写进正文。计划写完后不要在正文里要求用户回复「开始执行」，确认卡会单独出现。',
        })
      }
      const clarifyPhrases: string[] = []
      for (const item of turnHistory) {
        if (item.role !== 'user' && item.role !== 'assistant') continue
        if (item.status === 'error') continue
        chatMessages.push({ role: item.role, content: contentForModel(item, imageUrls) })
      }
      if (entry.cancelled) return
      const providers = await repos.providers.list()
      const provider = providers.find((item) => item.id === run.providerId)
      if (!provider) throw new AppError(400, '提供方已经不在了。')

      assistantId = crypto.randomUUID()
      const assistantCreatedAt = Date.now()
      const assistantBase = {
        id: assistantId,
        conversationId: entry.conversationId,
        role: 'assistant' as const,
        speakerFriendId: speaker?.id,
        runId,
        createdAt: assistantCreatedAt,
      }
      await repos.messages.put({ ...assistantBase, content: '', status: 'streaming' })

      let catalog: ToolCatalog = { tools: [], call: async () => '' }
      if (options.mcpCatalog) {
        try {
          catalog = await options.mcpCatalog({
            kind: conversation?.kind === 'group' ? 'group' : 'direct',
            ...(speaker?.id ? { speakerFriendId: speaker.id } : {}),
            ...(conversation ? { lineageId: conversation.lineageId || conversation.id } : {}),
          })
        } catch (error) {
          log('warn', 'mcp', '准备工具失败，这次发送不带外部工具', {
            conversationId: entry.conversationId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const codeBound = Boolean(actingFriend && options.codeTools?.isBound(actingFriend))
      const tools: OpenAiTool[] = [
        ...catalog.tools,
        ...(options.propose ? [PROPOSE_TOOL] : []),
        ...(options.getConfig ? [CONFIG_GET_TOOL] : []),
        ...(planTurn && options.clarify ? [CLARIFY_TOOL] : []),
        ...(codeBound && options.codeTools && actingFriend ? presentCodeTools(options.codeTools.tools, actingFriend) : []),
      ]
      const callTool: ToolCatalog['call'] = async (name, args, signal) => {
        if (name === PROPOSE_TOOL.function.name && options.propose) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {}
          } catch {
            return '参数不是 JSON，没有生成确认卡。'
          }
          return options.propose(entry.conversationId, parsed)
        }
        if (name === CLARIFY_TOOL.function.name && options.clarify && planTurn) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {}
          } catch {
            return '参数不是 JSON，没有生成澄清卡。'
          }
          if (typeof parsed.question === 'string') clarifyPhrases.push(parsed.question)
          if (Array.isArray(parsed.options)) {
            for (const option of parsed.options) {
              if (typeof option === 'string') clarifyPhrases.push(option)
            }
          }
          try {
            return await options.clarify(entry.conversationId, runId, parsed)
          } catch (error) {
            return error instanceof Error ? error.message : '没有生成澄清卡。'
          }
        }
        if (name === CONFIG_GET_TOOL.function.name && options.getConfig) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {}
          } catch {
            return '参数不是 JSON，没有读取配置。'
          }
          return options.getConfig(parsed)
        }
        if (options.codeTools && actingFriend && options.codeTools.tools.some((tool) => tool.function.name === name)) {
          return options.codeTools.call(name, args, {
            friend: actingFriend,
            conversationId: entry.conversationId,
            runId,
            ...(entry.autoConfirmCode ? { autoConfirm: true } : {}),
            ...(workspace?.autoFileOps ? { autoFileOps: true } : {}),
          })
        }
        return catalog.call(name, args, signal)
      }
      const turn = await runAssistantTurn({
        baseUrl: provider.baseUrl,
        apiKey: await resolveApiKey(provider),
        model: run.model,
        messages: chatMessages,
        signal: entry.controller.signal,
        tools,
        callTool,
        fetchImpl,
        conversationId: entry.conversationId,
        runId,
        onProgress: async (state) => {
          if (entry.cancelled) return
          await repos.messages.put({
            ...assistantBase,
            content: state.content,
            ...(state.reasoning ? { reasoning: state.reasoning } : {}),
            status: 'streaming',
          })
        },
      })

      await critical(runId, async () => {
        if (entry.cancelled || entry.controller.signal.aborted) {
          await eraseTurn(entry)
          return
        }
        const finishedAt = Date.now()
        const parsedPlan = planTurn ? parsePlanFromAssistant(turn.content) : null
        let visible = clarifyPhrases.length > 0 ? stripClarifyFromBody(turn.content, clarifyPhrases) : turn.content
        if (parsedPlan) visible = stripPlanConfirmAsk(visible)
        if (!visible.trim() && clarifyPhrases.length > 0) visible = '请在澄清卡中选择。'
        await repos.messages.put({
          ...assistantBase,
          content: visible,
          ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
          ...(memoryInject ? { memoryInject } : {}),
          status: 'complete',
        })
        if (parsedPlan && options.onPlanAssistant) {
          try {
            await options.onPlanAssistant({
              conversationId: entry.conversationId,
              content: turn.content,
              ...(speaker?.id ? { friendId: speaker.id } : {}),
            })
          } catch (error) {
            log('warn', 'plan', '回合结束后写计划失败', {
              conversationId: entry.conversationId,
              runId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        const user = await messageById(entry.conversationId, run.messageId)
        if (user) await repos.messages.put({ ...user, status: 'complete' })
        // 群主回复里 @ 了群友：在 run 收尾前把活交出去，页面下一次轮询就能看到指派卡。
        if (conversation?.kind === 'group' && speaker?.isOwnerTemplate && options.onGroupHandoff) {
          const handoff = handoffMention(turn.content, members, { excludeIds: [speaker.id] })
          if (handoff) {
            const instruction = (handoff.task.length >= 4 ? handoff.task : turn.content.trim()).slice(0, 2000)
            try {
              await options.onGroupHandoff({
                conversationId: entry.conversationId,
                fromFriendId: speaker.id,
                toFriendId: handoff.friend.id,
                instruction,
                runId,
              })
              log('info', 'session', '群主 @ 交办', {
                conversationId: entry.conversationId,
                runId,
                toFriendId: handoff.friend.id,
              })
            } catch (handoffError) {
              log('warn', 'session', '群主 @ 交办失败', {
                conversationId: entry.conversationId,
                runId,
                error: handoffError instanceof Error ? handoffError.message : String(handoffError),
              })
            }
          }
        }
        const done: Run = { ...run, status: 'done', finishedAt }
        await repos.runs.put(done)
        live.delete(runId)
        log('info', 'session', '生成完成', { conversationId: entry.conversationId, runId })
        try {
          await remember(repos, done)
        } catch (memoryError) {
          log('error', 'memory', '记忆写入失败', {
            conversationId: entry.conversationId,
            runId,
            error: memoryError instanceof Error ? memoryError.message : String(memoryError),
          })
        }
      })
    } catch (error) {
      await critical(runId, async () => {
        if (entry.cancelled || isAbort(error)) {
          await eraseTurn(entry)
          return
        }
        const current = await repos.runs.get(runId)
        if (!current || current.status === 'cancelled' || current.status === 'done') return
        const message = humanizeTurnError(error)
        await repos.runs.put({
          ...current,
          status: 'error',
          error: message,
          finishedAt: Date.now(),
        })
        const user = await messageById(entry.conversationId, current.messageId)
        if (user && (user.status === 'pending' || user.status === 'streaming')) {
          await repos.messages.put({ ...user, status: 'complete' })
        }
        if (assistantId) {
          const assistant = await messageById(entry.conversationId, assistantId)
          if (assistant) {
            await repos.messages.put({
              ...assistant,
              content: assistant.content?.trim() ? assistant.content : '',
              status: 'error',
              error: message,
            })
          }
        } else {
          await repos.messages.put({
            id: crypto.randomUUID(),
            conversationId: entry.conversationId,
            role: 'assistant',
            content: '',
            status: 'error',
            error: message,
            runId,
            speakerFriendId:
              current.speakerFriendId ?? (await repos.conversations.get(entry.conversationId))?.friendIds[0],
            createdAt: Date.now(),
          })
        }
        live.delete(runId)
        log('warn', 'session', '生成失败', {
          conversationId: entry.conversationId,
          runId,
          error: message,
        })
      })
    }
  }

  async function cancelRun(runId: string): Promise<CancelRunResult> {
    return critical(runId, async () => {
      const current = await repos.runs.get(runId)
      if (!current) throw new AppError(404, '找不到这个回合')
      if (current.status === 'cancelled') {
        return { run: current, draftText: current.draftText ?? '' }
      }
      if (current.status === 'done' || current.status === 'error') {
        throw new AppError(409, '这个回合已经结束，不能取消')
      }
      const entry = live.get(runId)
      const draftText = entry?.draftText || current.draftText || (await draftFromMessage(current))
      if (entry) {
        entry.cancelled = true
        entry.draftText = draftText
        if (entry.timer) clearTimeout(entry.timer)
        entry.controller.abort()
      }
      await repos.messages.deleteByRun(runId)
      const cancelled: Run = {
        ...current,
        status: 'cancelled',
        draftText,
        finishedAt: Date.now(),
      }
      await repos.runs.put(cancelled)
      live.delete(runId)
      log('info', 'session', '已取消', {
        conversationId: current.conversationId,
        runId,
        draftChars: draftText.length,
      })
      return { run: cancelled, draftText }
    })
  }

  async function eraseTurn(entry: LiveTurn): Promise<void> {
    const current = await repos.runs.get(entry.runId)
    await repos.messages.deleteByRun(entry.runId)
    if (!current || current.status === 'cancelled' || current.status === 'done') {
      live.delete(entry.runId)
      return
    }
    await repos.runs.put({
      ...current,
      status: 'cancelled',
      draftText: entry.draftText,
      finishedAt: Date.now(),
    })
    live.delete(entry.runId)
    log('info', 'session', '生成被取消，不写记忆', {
      conversationId: entry.conversationId,
      runId: entry.runId,
    })
  }

  async function draftFromMessage(run: Run): Promise<string> {
    if (!run.messageId) return ''
    const message = await messageById(run.conversationId, run.messageId)
    return message?.content ?? ''
  }

  async function messageById(conversationId: string, messageId: string | undefined): Promise<Message | undefined> {
    if (!messageId) return undefined
    const messages = await repos.messages.listByConversation(conversationId)
    return messages.find((item) => item.id === messageId)
  }

  async function recoverOrphanedRuns(): Promise<number> {
    const runs = await repos.runs.list()
    let fixed = 0
    const message = '上次发送中断了，模型没有回上。请再发一条，或先到设置里检查模型服务是否已启动。'
    for (const run of runs) {
      if (run.status !== 'pending' && run.status !== 'running') continue
      if (live.has(run.id)) continue
      await repos.runs.put({ ...run, status: 'error', error: message, finishedAt: Date.now() })
      const user = await messageById(run.conversationId, run.messageId)
      if (user && (user.status === 'pending' || user.status === 'streaming')) {
        await repos.messages.put({ ...user, status: 'complete' })
      }
      const related = await repos.messages.listByConversation(run.conversationId)
      const streaming = related.find((item) => item.runId === run.id && item.role === 'assistant' && (item.status === 'streaming' || item.status === 'pending'))
      if (streaming) {
        await repos.messages.put({
          ...streaming,
          content: streaming.content?.trim() ? streaming.content : '',
          status: 'error',
          error: message,
        })
      } else {
        await repos.messages.put({
          id: crypto.randomUUID(),
          conversationId: run.conversationId,
          role: 'assistant',
          content: '',
          status: 'error',
          error: message,
          runId: run.id,
          createdAt: Date.now(),
        })
      }
      fixed += 1
    }
    if (fixed) log('warn', 'session', '收口中断的发送', { fixed })
    return fixed
  }

  function dispose(): void {
    for (const entry of live.values()) {
      entry.cancelled = true
      if (entry.timer) clearTimeout(entry.timer)
      entry.controller.abort()
    }
    live.clear()
  }

  /** 等一个回合跑完；邮件任务用来拿最终结果再回信。 */
  async function waitForRun(
    runId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Run> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000
    const started = Date.now()
    for (;;) {
      const run = await repos.runs.get(runId)
      if (!run) throw new AppError(404, '找不到这个回合')
      if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') return run
      if (options.signal?.aborted) {
        await cancelRun(runId).catch(() => undefined)
        throw new AppError(400, '邮件任务已取消。')
      }
      if (Date.now() - started > timeoutMs) {
        await cancelRun(runId).catch(() => undefined)
        throw new AppError(400, '邮件任务超时，已终止。')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  return { sendTurn, cancelRun, waitForRun, dispose, delayOf, recoverOrphanedRuns }
}

export type SessionOrchestrator = ReturnType<typeof createOrchestrator>

function isAbort(error: unknown): boolean {
  if (error instanceof LlmError && error.code === 'abort') return true
  return error instanceof Error && error.name === 'AbortError'
}

/** 群聊时把成员名单和 @ 规则带给当前发言人。记忆只在群主这边；其他人只执行当前任务。 */
function buildGroupMentionPrompt(
  members: Friend[],
  speaker: Friend | undefined,
  conversation: import('../domain/types.ts').Conversation,
): string {
  const owner = members.find((friend) => friend.isOwnerTemplate)
  const roster = members
    .map((friend) => {
      const bound = resolveMemberWorkspace(conversation, friend).root
      const tags = [
        friend.id === owner?.id ? '群主 · 默认接话 · 持有本群记忆' : '不持有本群记忆',
        bound ? `工作目录 ${bound}` : '未绑工作目录',
      ].filter(Boolean)
      return `- @${friend.name}（${tags.join(' · ')}）：${friend.description || '群友'}`
    })
    .join('\n')
  const lines = [`群聊成员（用 @ 名字可以点名）：\n${roster}`]
  if (speaker && owner && speaker.id === owner.id) {
    lines.push(
      '用户没有 @ 人时由你（群主）接话。你持有本群的对话、摘要和长期记忆：先把目标收成可执行方案，再判断交给哪位群友。其他成员看不到更早的对话和记忆，所以 @好友名 后面必须写清自包含的任务（目标、约束、要改什么、怎么验收），系统会自动指派。点名时写对方自己的工作目录，不要把自己的目录交给对方。同一条回复里如果多次 @ 同一个人，真正的任务放在最后一次 @ 后面。不需要别人时直接回答。不要随便 @ 人，也不要假设对方读过上文。声称已经核对过工作目录、目录为空或没有某类文件之前，必须先调用 workbench_fs_list 或 workbench_fs_grep，并只根据工具返回下结论。',
    )
  } else if (speaker && owner && speaker.id !== owner.id) {
    lines.push(
      `用户点名 @${speaker.name}：你没有本群之前的对话、摘要或长期记忆。只根据当前这条消息处理，不要转派给群主或其他人，也不要编造更早的背景。`,
    )
  }
  return lines.join('\n\n')
}

export function humanizeTurnError(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.code === 'network' || error.code === 'timeout') {
      return '连不上模型。请确认本机模型已启动，再到设置 → 模型提供方里检查地址并探测。'
    }
    if (error.code === 'http' && (error.status === 401 || error.status === 403)) {
      return '模型服务拒绝访问。请到设置里为该提供方填好密钥后再试。'
    }
    if (error.code === 'http' && error.status === 404) {
      if (error.hint && !error.hint.includes('没有找到模型列表')) return error.hint
      return '找不到模型接口。请检查提供方地址是否以 /v1 结尾，并确认模型名正确。'
    }
    return error.message || '模型没有回上，请稍后再试。'
  }
  if (error instanceof AppError) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  return '模型没有回上，请稍后再试。'
}

function contentForModel(item: Message, imageUrls?: Map<string, string>): ChatContent {
  const text = item.content?.trim() ?? ''
  const attachments = item.attachments ?? []
  if (attachments.length === 0) return text
  const labels = attachments.map((att) => {
    if (att.kind === 'image') return `[图片: ${att.name}]`
    return `[附件: ${att.name}]`
  })
  const baseText = text ? `${text}\n\n${labels.join('\n')}` : labels.join('\n')
  if (item.role !== 'user' || !imageUrls || imageUrls.size === 0) return baseText
  const imageParts: ChatContentPart[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue
    const url = imageUrls.get(attachment.id)
    if (url) imageParts.push({ type: 'image_url', image_url: { url } })
  }
  if (imageParts.length === 0) return baseText
  const parts: ChatContentPart[] = [{ type: 'text', text: baseText || '请识别这些图片。' }]
  parts.push(...imageParts)
  return parts
}
