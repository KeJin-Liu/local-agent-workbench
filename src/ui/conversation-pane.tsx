/**
 * 会话正文。发送后用户消息立刻出现，模型会再等几秒；等待和生成时都可以取消。
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { Assignment, ChatMode, ClarifyCard, CodeAction, CodeToolTimelineEntry, Conversation, ConversationCard, Friend, MemoryInject, Message, MessageAttachment, PlanRecord, Proposal, Provider, PublicProvider, ReasoningLevel, Run, Skill, SkillExtractDraft, SkillSuggestion, Summary } from '../domain/types.ts'
import { requestJson, uploadMedia, type CancelPayload, type SendPayload, type ThreadLongTermMemories, type ThreadPayload } from './api.ts'
import { Avatar } from './avatar.tsx'
import { ConfigProposalBody } from './propose-config-body.tsx'
import { InjectPreview, InjectSources, LayersPanel, MemWriteToast, type MemWriteToastState } from './layers-memory.tsx'
import { LtmBanner, LtmPanel } from './ltm-panel.tsx'
import { MarkdownText } from './markdown.tsx'
import { SkillSuggestCard } from './skill-suggest-card.tsx'
import { SkillExtractCard } from './skill-extract-card.tsx'
import { CodeActionCard, CodeToolTimeline, workspaceChipLabel } from './code-cards.tsx'
import { filesFromClipboard, namePastedFiles } from './clipboard.ts'
import { sanitizeAssignmentText } from '../llm/tool-markup.ts'
import { previewMemberWorkspace } from '../domain/group-workspace.ts'
import { findMention } from '../domain/mentions.ts'
import { conversationSegments, groupLineage, latestGroups } from '../app/directory.ts'
import { buildChatTimeline, type TimelineSlot } from './chat-timeline.ts'

function PlanModeCard({
  plan,
  speaker,
  busy,
  onNotice,
  onConfirm,
  onCancel,
}: {
  plan: PlanRecord
  speaker: Friend | undefined
  busy: boolean
  onNotice: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const done = plan.steps.filter((step) => step.done).length
  return (
    <div className="msg">
      <Avatar avatar={speaker?.avatar} name={speaker?.name ?? '计划'} size="sm" />
      <div>
        <div className="who">{speaker?.name ?? '助手'} · 计划模式</div>
        <button
          type="button"
          className="plan-file-chip"
          title={plan.filePath}
          onClick={() => onNotice(`计划路径 ${plan.filePath}`)}
        >
          <span className="plan-file-icon" aria-hidden="true">📄</span>
          <span className="plan-file-meta">
            <span className="plan-file-name">{plan.filePath.split('/').pop()}</span>
            <span className="plan-file-path">{plan.filePath.replace(/[^/]+$/, '')}</span>
          </span>
        </button>
        {plan.status === 'awaiting_confirm' ? (
          <div className="confirm-card plan-confirm" role="group" aria-label="确认按计划执行">
            <div className="confirm-card-hd">
              <div className="cc-icon">📋</div>
              <div>
                <div className="cc-kind">计划模式</div>
                <div className="cc-title">开始执行计划？</div>
                <div className="cc-sub">确认前不写盘、不发信、不跑 shell</div>
              </div>
            </div>
            <div className="confirm-card-bd">
              <ul className="plan-outline">
                {plan.steps.map((step) => (
                  <li key={step.index}>
                    <span className="plan-check">{step.done ? '[x]' : '[ ]'}</span>
                    {step.title}
                  </li>
                ))}
              </ul>
              <p className="confirm-note">确认后逐步更新同一 MD：完成一步打 <code>[x]</code>；取消则丢弃执行、保留计划文件。</p>
            </div>
            <div className="confirm-card-ft">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onCancel}>
                取消
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={onConfirm}>
                开始执行
              </button>
            </div>
          </div>
        ) : (
          <p className="hint" style={{ marginTop: 6 }}>
            {plan.status === 'executing'
              ? `执行中 · 已完成 ${done}/${plan.steps.length}`
              : plan.status === 'done'
                ? '计划已全部完成'
                : plan.status === 'cancelled'
                  ? '已取消执行 · 计划文件保留'
                  : plan.status}
          </p>
        )}
      </div>
    </div>
  )
}

function ClarifyBubble({
  card,
  speaker,
  busy,
  onPick,
}: {
  card: ClarifyCard
  speaker: Friend | undefined
  busy: boolean
  onPick: (option: string) => void
}) {
  const open = card.status === 'open'
  return (
    <div className="msg">
      <Avatar avatar={speaker?.avatar} name={speaker?.name ?? '澄清'} size="sm" />
      <div>
        <div className="who">{speaker?.name ?? '助手'} · 澄清</div>
        <div className={open ? 'clarify-card clarify-open' : 'clarify-card'} role="group" aria-label="澄清确认">
          <div className="clarify-hd">{open ? '请选择' : '已选择'}</div>
          <div className="clarify-q">{card.question}</div>
          <div className="clarify-options">
            {card.options.map((option, index) => (
              <button
                key={option}
                type="button"
                className={card.picked === option ? 'clarify-opt is-picked' : 'clarify-opt'}
                disabled={!open || busy}
                onClick={() => onPick(option)}
              >
                <span className="clarify-n">{index + 1}</span>
                <span className="clarify-t">{option}</span>
              </button>
            ))}
          </div>
          {open ? <p className="clarify-hint">点选后会作为你的回复发出，不用再把序号打进输入框。</p> : null}
        </div>
      </div>
    </div>
  )
}

export function ConversationPane({
  conversation,
  provider,
  friends,
  providers = [],
  sendWaitSeconds = 5,
  insertText,
  onInsertConsumed,
  onOpenProviders,
  onOpenSettings,
  onBack,
  onActivity,
  onFreshThread,
  conversations = [],
  onSwitchConversation,
}: {
  conversation: Conversation | null
  provider?: Provider
  friends: Friend[]
  providers?: PublicProvider[]
  /** 全局发送等待秒数（设置页可改 1–10）。 */
  sendWaitSeconds?: number
  insertText?: string | null
  onInsertConsumed?: () => void
  onOpenProviders?: () => void
  /** 单聊打开该好友的编辑页；群聊打开群设置。 */
  onOpenSettings?: () => void
  onBack?: () => void
  onActivity?: () => void
  /** `/new_chat` 另起一段后，切到新的会话 id。列表仍是同一行。 */
  onFreshThread?: (conversationId: string) => void
  /** 本联系人的全部会话段；用于「会话列表」切回旧段。 */
  conversations?: ConversationCard[]
  onSwitchConversation?: (conversationId: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [codeActions, setCodeActions] = useState<CodeAction[]>([])
  const [codeTimeline, setCodeTimeline] = useState<CodeToolTimelineEntry[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [ltm, setLtm] = useState<ThreadLongTermMemories | null>(null)
  const [ltmOpen, setLtmOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [layersTab, setLayersTab] = useState<'working' | 'summary' | 'ltm'>('summary')
  const [memoryInjectPreview, setMemoryInjectPreview] = useState<MemoryInject | null>(null)
  const [writeToast, setWriteToast] = useState<MemWriteToastState>(null)
  const [injectPreviewSource, setInjectPreviewSource] = useState<'working' | 'summary' | 'ltmFriend' | 'ltmProject' | null>(null)
  const lastSummaryUpdatedRef = useRef<number | null>(null)
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>([])
  const [skillExtractDrafts, setSkillExtractDrafts] = useState<SkillExtractDraft[]>([])
  const [extracting, setExtracting] = useState(false)
  const [skillOpen, setSkillOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [lastSent, setLastSent] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [mentionMenu, setMentionMenu] = useState<{ start: number; query: string; index: number } | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const filePickerRef = useRef<HTMLInputElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionCaretRef = useRef<number | null>(null)
  const conversationId = conversation?.id ?? null
  const [modelMenu, setModelMenu] = useState(false)
  const [barModelMenu, setBarModelMenu] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [chatMode, setChatMode] = useState<ChatMode>('normal')
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>('medium')
  const [plans, setPlans] = useState<PlanRecord[]>([])
  const [clarifies, setClarifies] = useState<ClarifyCard[]>([])
  const [planBusy, setPlanBusy] = useState(false)
  const sawBusy = useRef(false)
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  // 群聊默认发言人是群主；@ 点名时用当前草稿解析出的好友做提示。
  const speaker =
    friends.find(
      (friend) =>
        conversation?.kind === 'group' &&
        friend.isOwnerTemplate &&
        Boolean(conversation.friendIds.includes(friend.id)),
    ) ?? friends.find((friend) => friend.id === conversation?.friendIds[0])
  const speakerModel = speaker?.defaultModelId
  // 只在换会话时清空草稿和消息。模式、推理程度、模型会回写同一条会话，
  // 若跟 conversationId 绑在同一次重置里，未发送的输入和已加载的消息会被整页刷掉。
  useEffect(() => {
    setDraft('')
    setSelectedProviderId(null)
    setMessages([])
    setRuns([])
    setAssignments([])
    setCodeActions([])
    setCodeTimeline([])
    setSummary(null)
    setSummaryOpen(false)
    setLtm(null)
    setLtmOpen(false)
    setLayersOpen(false)
    setLayersTab('summary')
    setMemoryInjectPreview(null)
    setWriteToast(null)
    setInjectPreviewSource(null)
    lastSummaryUpdatedRef.current = null
    setSkillSuggestions([])
    setSkillExtractDrafts([])
    setExtracting(false)
    setSkillOpen(false)
    setAssignOpen(false)
    setActiveRunId(null)
    setNotice('')
    setError('')
    setModelMenu(false)
    setBarModelMenu(false)
    setSessionsOpen(false)
    setPlans([])
    setClarifies([])
    setPlanBusy(false)
    setLastSent('')
    setSendFailed(false)
    setPendingAttachments([])
    setMentionMenu(null)
    setLightboxSrc(null)
    setCopyState('idle')
  }, [conversationId])

  // 群聊的模型记在会话上。群主自己的默认模型只在会话还没选过时兜底，刷新不能把它盖回来。
  const rememberedModel =
    conversation?.kind === 'group'
      ? conversation.model || speakerModel || ''
      : speakerModel || conversation?.model || ''
  useEffect(() => {
    setModel(rememberedModel)
    if (conversation?.kind === 'group' && conversation.providerId) {
      setSelectedProviderId(conversation.providerId)
    }
  }, [conversationId, rememberedModel, conversation?.kind, conversation?.providerId])

  useEffect(() => {
    setChatMode(conversation?.chatMode === 'plan' ? 'plan' : 'normal')
    setReasoningLevel(
      conversation?.reasoningLevel === 'low' || conversation?.reasoningLevel === 'high'
        ? conversation.reasoningLevel
        : 'medium',
    )
  }, [conversationId, conversation?.chatMode, conversation?.reasoningLevel])

  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setLightboxSrc(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  useEffect(() => {
    if (!insertText) return
    setDraft((current) => {
      const next = current.trim() ? `${current.trim()}\n\n${insertText}` : insertText
      return next
    })
    onInsertConsumed?.()
  }, [insertText, onInsertConsumed])

  // 聊天区任意位置 Cmd/Ctrl+V：剪贴板里有文件就当附件；输入框和弹层保留原生粘贴。
  useEffect(() => {
    if (!conversationId) return
    function onWindowPaste(event: ClipboardEvent) {
      if (pending || activeRunId) return
      if (conversation?.kind === 'group' && conversation.archived) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const files = filesFromClipboard(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      setError('')
      void enqueueUploads(namePastedFiles(files))
      composerRef.current?.focus()
    }
    document.addEventListener('paste', onWindowPaste)
    return () => document.removeEventListener('paste', onWindowPaste)
  }, [conversationId, conversation?.archived, pending, activeRunId])

  // 指派在后台跑工具循环时也要持续轮询：进度和回流结果都靠这条线刷新。
  const assignmentRunning = assignments.some((item) => item.status === 'pending' && !item.error)

  useEffect(() => {
    if (!conversationId) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const payload = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(conversationId)}/thread`)
        if (stop) return
        setMessages(payload.messages)
        setRuns(payload.runs)
        if (payload.messages.some((item) => item.status === 'error') || payload.runs.some((run) => run.status === 'error')) {
          setSendFailed(true)
        } else if (!payload.runs.some((run) => run.status === 'pending' || run.status === 'running')) {
          /* keep sendFailed until user retries successfully */
        }
        setAssignments(payload.assignments)
        setSummary(payload.summary)
        setLtm(payload.longTermMemories)
        setMemoryInjectPreview(payload.memoryInject ?? null)
        setSkillSuggestions(payload.skillSuggestions ?? [])
        setSkillExtractDrafts(payload.skillExtractDrafts ?? [])
        const summaryUpdated = payload.summary?.updatedAt ?? null
        if (
          summaryUpdated &&
          lastSummaryUpdatedRef.current != null &&
          summaryUpdated > lastSummaryUpdatedRef.current &&
          payload.summary?.injectOnNextTurn
        ) {
          setWriteToast({
            text: payload.summary.source === 'manual' ? '已写入事件摘要' : '已写入事件摘要 · 将注入后续回合',
            variant: 'summary',
          })
        }
        if (summaryUpdated) lastSummaryUpdatedRef.current = summaryUpdated
        else if (lastSummaryUpdatedRef.current == null) lastSummaryUpdatedRef.current = 0
        const cards = await requestJson<{ ok: true; proposals: Proposal[] }>(
          `/api/conversations/${encodeURIComponent(conversationId)}/proposals`,
        )
        if (!stop) setProposals(cards.proposals)
        const codeCards = await requestJson<{ ok: true; actions: CodeAction[] }>(
          `/api/conversations/${encodeURIComponent(conversationId)}/code-actions`,
        )
        if (!stop) setCodeActions(codeCards.actions)
        const timeline = await requestJson<{ ok: true; events: CodeToolTimelineEntry[] }>(
          `/api/conversations/${encodeURIComponent(conversationId)}/code-timeline`,
        )
        if (!stop) setCodeTimeline(timeline.events)
        if (!stop) {
          setChatMode(payload.conversation.chatMode === 'plan' ? 'plan' : 'normal')
          setReasoningLevel(
            payload.conversation.reasoningLevel === 'low' || payload.conversation.reasoningLevel === 'high'
              ? payload.conversation.reasoningLevel
              : 'medium',
          )
        }
        try {
          const plansPayload = await requestJson<{ ok: true; plans: PlanRecord[] }>(
            `/api/conversations/${encodeURIComponent(conversationId)}/plans`,
          )
          if (!stop) setPlans(plansPayload.plans)
        } catch {
          if (!stop) setPlans([])
        }
        try {
          const clarifyPayload = await requestJson<{ ok: true; clarifies: ClarifyCard[] }>(
            `/api/conversations/${encodeURIComponent(conversationId)}/clarifies`,
          )
          if (!stop) setClarifies(clarifyPayload.clarifies)
        } catch {
          if (!stop) setClarifies([])
        }
        const busy = payload.runs.some((run) => run.status === 'pending' || run.status === 'running')
        const assigning = payload.assignments.some((item) => item.status === 'pending' && !item.error)
        if (busy || assigning) {
          sawBusy.current = true
          timer = setTimeout(() => void tick(), 400)
        } else {
          if (activeRunId) setActiveRunId(null)
          if (sawBusy.current) {
            sawBusy.current = false
            onActivityRef.current?.()
          }
        }
      } catch (cause) {
        if (!stop) setError(cause instanceof Error ? cause.message : '读不到消息')
      }
    }
    void tick()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
  }, [conversationId, activeRunId, assignmentRunning])

  if (!conversation) {
    return (
      <main className="chat empty-chat">
        <div className="center-copy">
          <h2>选一位好友或群</h2>
          <p>从左边通讯录点开即可开始聊。资料在顶栏齿轮里。</p>
        </div>
      </main>
    )
  }

  const current = conversation
  /** 按 run 分组：每次发送各一条工具轨迹，不再整会话累积成一长条。 */
  const timelineByRun = new Map<string, CodeToolTimelineEntry[]>()
  for (const entry of codeTimeline) {
    const key = entry.runId ?? '__orphan__'
    const bucket = timelineByRun.get(key)
    if (bucket) bucket.push(entry)
    else timelineByRun.set(key, [entry])
  }
  const chatTimeline = buildChatTimeline({
    messages,
    proposals,
    codeActions,
    plans,
    clarifies,
    toolEvents: codeTimeline,
  })
  const names = current.friendIds
    .map((id) => friends.find((friend) => friend.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  const groupMembers =
    current.kind === 'group'
      ? current.friendIds
          .map((id) => friends.find((friend) => friend.id === id))
          .filter((friend): friend is Friend => Boolean(friend))
      : []
  const mentionTarget = groupMembers.length > 0 && draft ? findMention(draft, groupMembers) : null
  const mentionToOther = Boolean(mentionTarget && mentionTarget.friend.id !== speaker?.id)
  const sessions = conversationSegments(conversations, current)
  const mentionCandidates = mentionMenu
    ? groupMembers
        .filter((friend) => friend.name.toLowerCase().includes(mentionMenu.query.trim().toLowerCase()))
        .slice(0, 6)
    : []
  const active = runs.find((run) => run.status === 'pending' || run.status === 'running') ?? null
  const latestRunError = !active ? runs.filter((run) => run.status === 'error' && run.error).at(-1)?.error : undefined
  const hasErrorMsg = messages.some((item) => item.status === 'error')
  const hintFailed = sendFailed || Boolean(latestRunError) || hasErrorMsg
  const archivedChat = current.kind === 'group' && current.archived === true
  const sendHint = archivedChat
    ? '已归档 · 在群设置里取消归档后才能继续聊天'
    : active
      ? `发送后约 ${sendWaitSeconds} 秒可终止 · 点「终止」会把原文回填输入框`
      : hintFailed
        ? '发送失败 · 可重试或去设置检查提供方'
        : chatMode === 'plan'
          ? '底栏仅附件 + 发送 · 「保存为技能」在上方栏 · 计划模式'
          : '底栏仅附件 + 发送 · 「保存为技能」在上方栏'
  const sendHintClass = archivedChat ? 'hint' : active ? 'hint is-running' : hintFailed ? 'hint is-error' : 'hint'

  async function patchComposer(patch: {
    chatMode?: ChatMode
    reasoningLevel?: ReasoningLevel
    model?: string
    providerId?: string
  }) {
    const payload = await requestJson<{ ok: true; conversation: Conversation }>(
      `/api/conversations/${encodeURIComponent(current.id)}/composer`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
    if (payload.conversation.chatMode === 'plan' || payload.conversation.chatMode === 'normal') {
      setChatMode(payload.conversation.chatMode)
    }
    if (payload.conversation.reasoningLevel) setReasoningLevel(payload.conversation.reasoningLevel)
    if (payload.conversation.model) setModel(payload.conversation.model)
    if (payload.conversation.providerId) setSelectedProviderId(payload.conversation.providerId)
    onActivity?.()
    return payload.conversation
  }

  function chooseModel(providerId: string, modelId: string) {
    setSelectedProviderId(providerId)
    setModel(modelId)
    setModelMenu(false)
    setBarModelMenu(false)
    setNotice('')
    void patchComposer({ model: modelId, providerId }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : '模型未保存')
    })
    const friendId = current.friendIds[0]
    if (current.kind !== 'direct' || !friendId) return
    const friend = friends.find((entry) => entry.id === friendId)
    if (!friend) return
    void requestJson(`/api/friends/${encodeURIComponent(friendId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: friend.name,
        description: friend.description,
        systemPrompt: friend.systemPrompt,
        providerId,
        defaultModelId: modelId,
        avatar: friend.avatar,
        workspacePath: friend.workspacePath ?? '',
        codePermission: friend.codePermission ?? 'workspace-write',
      }),
    })
      .then(() => onActivity?.())
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : '没有保存默认模型')
      })
  }

  async function startNewChat() {
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; conversation: Conversation }>(
        `/api/conversations/${encodeURIComponent(current.id)}/new-chat`,
        { method: 'POST' },
      )
      setDraft('')
      setMessages([])
      setPlans([])
      setClarifies([])
      setNotice('已开新对话')
      onFreshThread?.(payload.conversation.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有另起对话')
    } finally {
      setPending(false)
    }
  }

  function replacePlan(plan: PlanRecord) {
    setPlans((current) => current.map((item) => (item.id === plan.id ? plan : item)))
  }

  async function confirmPlan(planId: string) {
    setPlanBusy(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; plan: PlanRecord }>(
        `/api/plans/${encodeURIComponent(planId)}/confirm`,
        { method: 'POST' },
      )
      replacePlan(payload.plan)
      setNotice('已开始执行 · 确认门闩已过')
      onActivity?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认执行失败')
    } finally {
      setPlanBusy(false)
    }
  }

  async function cancelPlan(planId: string) {
    setPlanBusy(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; plan: PlanRecord }>(
        `/api/plans/${encodeURIComponent(planId)}/cancel`,
        { method: 'POST' },
      )
      replacePlan(payload.plan)
      setNotice('已取消 · 未执行')
      onActivity?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败')
    } finally {
      setPlanBusy(false)
    }
  }

  async function pickClarify(cardId: string, option: string) {
    setPlanBusy(true)
    setError('')
    try {
      const answered = await requestJson<{ ok: true; clarify: ClarifyCard }>(
        `/api/clarifies/${encodeURIComponent(cardId)}/answer`,
        { method: 'POST', body: JSON.stringify({ option }) },
      )
      setClarifies((current) => current.map((item) => (item.id === answered.clarify.id ? answered.clarify : item)))
      const payload = await requestJson<SendPayload>(`/api/conversations/${encodeURIComponent(current.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({
          text: option,
          ...(current.kind === 'group' ? {} : { model, ...(selectedProviderId ? { providerId: selectedProviderId } : {}) }),
        }),
      })
      setActiveRunId(payload.run.id)
      setMessages((list) => (list.some((item) => item.id === payload.message.id) ? list : [...list, payload.message]))
      setNotice('已按澄清卡发出')
      onActivity?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有发出选择')
    } finally {
      setPlanBusy(false)
    }
  }

  async function onSend(event: FormEvent) {
    event.preventDefault()
    if (current.kind === 'group' && current.archived) {
      setError('这个群已归档，取消归档后才能继续聊天。')
      return
    }
    if (draft.trim() === '/new_chat') {
      setPending(true)
      setError('')
      try {
        const payload = await requestJson<{ ok: true; conversation: Conversation }>(
          `/api/conversations/${encodeURIComponent(current.id)}/new-chat`,
          { method: 'POST' },
        )
        setDraft('')
        setMessages([])
        setNotice('已开新对话')
        onFreshThread?.(payload.conversation.id)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '没有另起对话')
      } finally {
        setPending(false)
      }
      return
    }
    const text = draft
    const ready = pendingAttachments.filter((item) => item.status === 'ready' && item.attachment)
    const uploading = pendingAttachments.some((item) => item.status === 'uploading')
    if (!text.trim() && ready.length === 0) {
      if (uploading) setError('有文件仍在上传，可先发文字或等完成')
      return
    }
    if (uploading) {
      setNotice('有文件仍在上传；本次只发送已完成的附件与文字')
    }
    setPending(true)
    setError('')
    setSendFailed(false)
    setLastSent(text)
    try {
      const payload = await requestJson<SendPayload>(`/api/conversations/${encodeURIComponent(current.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          // 群聊由服务端按发言人取本群模型；点名其他好友时也不要把群主的模型带过去。
          ...(current.kind === 'group' || mentionToOther
            ? {}
            : { model, ...(selectedProviderId ? { providerId: selectedProviderId } : {}) }),
          ...(ready.length ? { attachmentIds: ready.map((item) => item.attachment!.id) } : {}),
        }),
      })
      setDraft('')
      setMentionMenu(null)
      setPendingAttachments((current) => current.filter((item) => item.status === 'uploading'))
      setActiveRunId(payload.run.id)
      setMessages((current) => (current.some((item) => item.id === payload.message.id) ? current : [...current, payload.message]))
      setNotice(
        mentionToOther && mentionTarget
          ? `已点名 @${mentionTarget.friend.name}，由 TA 直接回复，不带本群之前的记忆。`
          : payload.run.vision
            ? `已发出 · 视觉插件用 ${payload.run.model} 识别本回合图片。`
            : payload.delayMs > 0
              ? `已发出。约 ${Math.round(payload.delayMs / 1000)} 秒后调模型，可点「终止」撤回。`
              : '已发出，正在调模型…',
      )
      onActivity?.()
    } catch (cause) {
      setSendFailed(true)
      setError(cause instanceof Error ? cause.message : '连不上模型')
    } finally {
      setPending(false)
    }
  }

  async function onCancel() {
    if (!active) return
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<CancelPayload>(`/api/runs/${encodeURIComponent(active.id)}/cancel`, {
        method: 'POST',
      })
      setDraft(payload.draftText || lastSent)
      setActiveRunId(null)
      setSendFailed(false)
      setNotice('已取消，原文回到输入框。这次不会写入记忆。')
      const thread = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`)
      setMessages(thread.messages)
      setRuns(thread.runs)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有取消')
    } finally {
      setPending(false)
    }
  }

  function onComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMenu && mentionCandidates.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setMentionMenu({
          ...mentionMenu,
          index: (mentionMenu.index + delta + mentionCandidates.length) % mentionCandidates.length,
        })
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const friend = mentionCandidates[Math.min(mentionMenu.index, mentionCandidates.length - 1)]
        if (friend) applyMention(friend)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionMenu(null)
        return
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (active || pending) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  /** 输入 @ 后按已输入的名字过滤群友；点选或回车插入 @名字。 */
  function syncMentionMenu(value: string, caret: number | null) {
    if (current.kind !== 'group' || groupMembers.length === 0) {
      setMentionMenu(null)
      return
    }
    const position = caret ?? value.length
    const before = value.slice(0, position)
    const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('＠'))
    if (at < 0) {
      setMentionMenu(null)
      return
    }
    const previous = at > 0 ? before[at - 1] ?? '' : ''
    if (previous && /[A-Za-z0-9._%+-]/.test(previous)) {
      setMentionMenu(null)
      return
    }
    const query = before.slice(at + 1)
    if (query.includes('\n') || query.length > 24) {
      setMentionMenu(null)
      return
    }
    // 名字已经完整、又敲了空格：认为 @ 结束，别再拦 Enter。
    const trimmed = query.trim()
    if (/\s$/.test(query) && groupMembers.some((friend) => friend.name === trimmed)) {
      setMentionMenu(null)
      return
    }
    const matches = groupMembers.filter((friend) =>
      friend.name.toLowerCase().includes(trimmed.toLowerCase()),
    )
    if (matches.length === 0) {
      setMentionMenu(null)
      return
    }
    setMentionMenu({ start: at, query, index: 0 })
  }

  function applyMention(friend: Friend) {
    if (!mentionMenu) return
    const caret = composerRef.current?.selectionStart ?? draft.length
    const start = Math.min(mentionMenu.start, draft.length)
    const end = Math.max(caret, start)
    const next = `${draft.slice(0, start)}@${friend.name} ${draft.slice(end)}`
    mentionCaretRef.current = start + friend.name.length + 2
    setDraft(next)
    setMentionMenu(null)
  }

  // 插入 @名字 后同步把光标放到空格后；rAF 太晚，紧接着打字会被插到旧位置。
  useLayoutEffect(() => {
    const position = mentionCaretRef.current
    if (position == null) return
    mentionCaretRef.current = null
    const textarea = composerRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(position, position)
  }, [draft])

  /** 输入框里粘贴附件；纯文字仍走浏览器默认粘贴。 */
  function onComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromClipboard(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    if (active || pending) return
    setError('')
    void enqueueUploads(namePastedFiles(files))
  }

  async function enqueueUploads(files: File[]) {
    const rows: PendingAttachment[] = files.map((file) => {
      const isImage = file.type.startsWith('image/')
      return {
        localId: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        kind: isImage ? 'image' : 'file',
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        status: 'uploading',
      }
    })
    setPendingAttachments((current) => [...current, ...rows])
    await Promise.all(
      rows.map(async (row, index) => {
        const file = files[index]
        try {
          const attachment = await uploadMedia(file)
          setPendingAttachments((current) =>
            current.map((item) =>
              item.localId === row.localId ? { ...item, status: 'ready', attachment } : item,
            ),
          )
        } catch (cause) {
          setPendingAttachments((current) =>
            current.map((item) =>
              item.localId === row.localId
                ? { ...item, status: 'error', error: cause instanceof Error ? cause.message : '上传失败' }
                : item,
            ),
          )
        }
      }),
    )
  }

  const effectiveProvider =
    providers.find((item) => item.id === selectedProviderId) ??
    provider ??
    providers.find((item) => item.enabled && item.defaultModel === model) ??
    providers.find((item) => item.enabled)
  const modelLabel = !effectiveProvider
    ? '尚未指定模型'
    : !model
      ? `${effectiveProvider.name} · 尚未指定模型`
      : `${effectiveProvider.name.replace(/ 本地$/, '')} · ${model}`

  useEffect(() => {
    if (!summaryOpen && !ltmOpen && !layersOpen && !modelMenu && !barModelMenu && !sessionsOpen && !injectPreviewSource) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSummaryOpen(false)
      setLtmOpen(false)
      setLayersOpen(false)
      setInjectPreviewSource(null)
      setModelMenu(false)
      setBarModelMenu(false)
      setSessionsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [summaryOpen, ltmOpen, layersOpen, modelMenu, barModelMenu, sessionsOpen, injectPreviewSource])

  useEffect(() => {
    if (!barModelMenu) return
    const onPointer = () => setBarModelMenu(false)
    window.addEventListener('click', onPointer)
    return () => window.removeEventListener('click', onPointer)
  }, [barModelMenu])

  useEffect(() => {
    if (!sessionsOpen) return
    const onPointer = () => setSessionsOpen(false)
    window.addEventListener('click', onPointer)
    return () => window.removeEventListener('click', onPointer)
  }, [sessionsOpen])

  const headerFriend = mentionToOther && mentionTarget ? mentionTarget.friend : speaker
  const headerWorkspace = headerFriend ? previewMemberWorkspace(current, headerFriend).path : ''

  function renderTimelineCard(item: TimelineSlot): ReactNode {
    if (item.kind === 'proposal') {
      const proposal = proposals.find((entry) => entry.id === item.id)
      if (!proposal) return null
      return (
        <ConfirmCard
          key={proposal.id}
          proposal={proposal}
          friends={friends}
          onDone={() => {
            void requestJson<{ ok: true; proposals: Proposal[] }>(
              `/api/conversations/${encodeURIComponent(current.id)}/proposals`,
            ).then((payload) => setProposals(payload.proposals))
            onActivity?.()
          }}
        />
      )
    }
    if (item.kind === 'code') {
      const action = codeActions.find((entry) => entry.id === item.id)
      if (!action) return null
      return (
        <div key={action.id} className="msg">
          <Avatar avatar={speaker?.avatar} name={speaker?.name ?? '编码'} size="sm" />
          <div>
            <div className="who">{speaker?.name ?? '编码'} · 本机编码</div>
            <CodeActionCard
              action={action}
              onDone={() => {
                void requestJson<{ ok: true; actions: CodeAction[] }>(
                  `/api/conversations/${encodeURIComponent(current.id)}/code-actions`,
                ).then((payload) => setCodeActions(payload.actions))
                void requestJson<{ ok: true; events: CodeToolTimelineEntry[] }>(
                  `/api/conversations/${encodeURIComponent(current.id)}/code-timeline`,
                ).then((payload) => setCodeTimeline(payload.events))
                onActivity?.()
              }}
            />
          </div>
        </div>
      )
    }
    if (item.kind === 'tools') {
      const events = timelineByRun.get(item.id.slice('tools:'.length))
      if (!events?.length) return null
      return <ToolTrackBlock key={item.id} events={events} friends={friends} fallback={speaker} />
    }
    if (item.kind === 'clarify') {
      const card = clarifies.find((entry) => entry.id === item.id)
      if (!card) return null
      return (
        <ClarifyBubble
          key={card.id}
          card={card}
          speaker={speaker}
          busy={planBusy || Boolean(active)}
          onPick={(option) => void pickClarify(card.id, option)}
        />
      )
    }
    if (item.kind === 'plan') {
      const plan = plans.find((entry) => entry.id === item.id)
      if (!plan) return null
      return (
        <PlanModeCard
          key={plan.id}
          plan={plan}
          speaker={speaker}
          busy={planBusy}
          onNotice={setNotice}
          onConfirm={() => void confirmPlan(plan.id)}
          onCancel={() => void cancelPlan(plan.id)}
        />
      )
    }
    return null
  }

  return (
    <main className="chat">
      <header className="chat-hd" style={{ position: 'relative' }}>
        <div className="chat-hd-row">
          {onBack ? (
            <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={onBack}>
              返回
            </button>
          ) : null}
          {current.kind === 'group' ? <Avatar avatar={current.avatar} name="群" size="sm" /> : null}
          <span className="chat-title">{conversation.title}</span>
          {current.kind !== 'group' ? (
            <button type="button" className="chip" title="当前模型" onClick={() => setModelMenu((value) => !value)}>
              {modelLabel}
            </button>
          ) : null}
          {headerFriend ? (
            <button
              type="button"
              className="chip chip-ws"
              title={headerWorkspace || '未设工作目录（可选）'}
              onClick={() => onOpenSettings?.()}
            >
              {workspaceChipLabel(headerWorkspace)}
            </button>
          ) : null}
          <div className="grow" />
          {chatMode === 'plan' ? <span className="tag tag-ok">计划模式</span> : null}
          {onOpenSettings ? (
            <button
              type="button"
              className="chat-gear"
              title={current.kind === 'group' ? '群设置' : '好友设置'}
              aria-label={current.kind === 'group' ? '群设置' : '好友设置'}
              onClick={onOpenSettings}
            >
              <svg className="chat-gear-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.22 1.12-.54 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="chat-hd-tools" aria-label="会话工具">
          {summary?.injectOnNextTurn ? (
            <button type="button" className="chip chip-memory" title="事件摘要将注入后续回合" onClick={() => { setLtmOpen(false); setSummaryOpen(false); setLayersTab('summary'); setLayersOpen(true) }}>
              <span className="dot" aria-hidden="true" />
              摘要已注入
            </button>
          ) : null}
          {(ltm?.injectable.length ?? 0) > 0 ? (
            <button type="button" className="chip chip-ltm" title="跨会话持久；与会话摘要不同" onClick={() => { setSummaryOpen(false); setLtmOpen(false); setLayersTab('ltm'); setLayersOpen(true) }}>
              <span className="dot" aria-hidden="true" />
              长期记忆 · {ltm!.injectable.length}
            </button>
          ) : null}
          <button
            type="button"
            className={layersOpen ? 'chip chip-layers is-active' : 'chip chip-layers'}
            title="打开分层记忆"
            aria-expanded={layersOpen}
            onClick={() => {
              setSummaryOpen(false)
              setLtmOpen(false)
              setLayersOpen((value) => !value)
            }}
          >
            记忆 · 三层
          </button>
          <button type="button" className="chip chip-muted" onClick={() => { setLtmOpen(false); setSummaryOpen(false); setLayersTab('summary'); setLayersOpen(true) }}>
            查看摘要
          </button>
          <button type="button" className="chip chip-muted" onClick={() => { setSummaryOpen(false); setLtmOpen(false); setLayersTab('ltm'); setLayersOpen(true) }}>
            管理记忆
          </button>
          <button
            type="button"
            className="chip chip-muted"
            title={current.id}
            onClick={() => {
              void copyConversationId(current.id)
                .then(() => flashCopyState(setCopyState, 'ok'))
                .catch(() => flashCopyState(setCopyState, 'fail'))
            }}
          >
            {copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制会话 ID'}
          </button>
        </div>
        {layersOpen ? (
          <LayersPanel
            layer={layersTab}
            onLayer={setLayersTab}
            summary={summary}
            messages={messages}
            ltm={ltm}
            friendName={speaker?.name ?? ''}
            projectName={current.kind === 'group' ? current.title : ''}
            pending={pending}
            memoryInject={memoryInjectPreview}
            onClose={() => setLayersOpen(false)}
            onGenerateSummary={() =>
              void regenerateSummary(current.id, setSummary, setError, setPending).then((summary) => {
                if (summary) setWriteToast({ text: '已写入事件摘要', variant: 'summary' })
              })
            }
            onInjectSummary={() =>
              void keepSummary(current.id, setSummary, setError, setPending, () => {
                setWriteToast({ text: '事件摘要将注入后续回合', variant: 'summary' })
              })
            }
            onChanged={async () => {
              const thread = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`)
              setLtm(thread.longTermMemories)
              setSummary(thread.summary)
              setMemoryInjectPreview(thread.memoryInject ?? null)
              setSkillSuggestions(thread.skillSuggestions ?? [])
              setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
            }}
            onToast={setWriteToast}
          />
        ) : null}
        {!layersOpen && summaryOpen ? (
          <SummaryPanel
            summary={summary}
            pending={pending}
            onClose={() => setSummaryOpen(false)}
            onGenerate={() => void regenerateSummary(current.id, setSummary, setError, setPending)}
            onInject={() => void keepSummary(current.id, setSummary, setError, setPending, () => setSummaryOpen(false))}
          />
        ) : null}
        {!layersOpen && ltmOpen && ltm ? (
          <LtmPanel
            bundle={ltm}
            friendName={speaker?.name ?? ''}
            projectName={current.kind === 'group' ? current.title : ''}
            onClose={() => setLtmOpen(false)}
            onChanged={async () => {
              const thread = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`)
              setLtm(thread.longTermMemories)
              setSkillSuggestions(thread.skillSuggestions ?? [])
              setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
            }}
            onWrote={() => setWriteToast({ text: '已写入好友长期记忆', variant: 'ltm' })}
          />
        ) : null}
        {injectPreviewSource ? (
          <InjectPreview
            source={injectPreviewSource}
            summary={summary}
            messages={messages}
            ltm={ltm}
            inject={memoryInjectPreview}
            onClose={() => setInjectPreviewSource(null)}
          />
        ) : null}
        <MemWriteToast toast={writeToast} onDismiss={() => setWriteToast(null)} />
        {modelMenu ? (
          <div className="model-menu is-open" role="menu" aria-label="选择提供方与模型">
            {providers.length === 0 ? (
              <div className="model-menu-sec">还没有提供方</div>
            ) : (
              providers.map((item) => {
                const models = item.probedModels?.length
                  ? item.probedModels
                  : item.defaultModel
                    ? [item.defaultModel]
                    : []
                const disabled = !item.enabled
                return (
                  <div key={item.id}>
                    <div className={disabled ? 'model-menu-sec is-disabled' : 'model-menu-sec'}>
                      {item.name}{disabled ? ' · 停用' : ''}
                    </div>
                    {disabled ? (
                      <button type="button" className="model-opt is-disabled" disabled aria-disabled="true">
                        <span className="check" />
                        <span className="opt-body">
                          {item.name}
                          <div className="sub">{item.baseUrl}</div>
                        </span>
                      </button>
                    ) : models.length === 0 ? (
                      <button
                        type="button"
                        className="model-opt"
                        onClick={() => {
                          setSelectedProviderId(item.id)
                          setModel('')
                          setNotice('请先到设置探测并选择模型')
                        }}
                      >
                        <span className="check" />
                        <span className="opt-body">
                          尚未指定模型
                          <div className="need-model">请先探测并选择模型 id</div>
                        </span>
                      </button>
                    ) : (
                      models.map((id) => {
                        const selected = (selectedProviderId ?? effectiveProvider?.id) === item.id && model === id
                        return (
                          <button
                            key={`${item.id}:${id}`}
                            type="button"
                            className={selected ? 'model-opt is-selected' : 'model-opt'}
                            onClick={() => chooseModel(item.id, id)}
                          >
                            <span className="check">{selected ? '✓' : ''}</span>
                            <span className="opt-body">
                              {id}
                              <div className="sub">{item.baseUrl}</div>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                )
              })
            )}
            {onOpenProviders ? (
              <button type="button" className="menu-link" onClick={onOpenProviders}>
                管理提供方…
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="chat-bd">
        {summary?.injectOnNextTurn ? (
          <div className="memory-banner" role="status">
            <span className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
            <span>
              <strong>事件摘要</strong> 已写入记忆，将注入后续回合
            </span>
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setLtmOpen(false)
                setSummaryOpen(false)
                setLayersTab('summary')
                setLayersOpen(true)
              }}
            >
              查看
            </button>
          </div>
        ) : null}
        <LtmBanner
          bundle={ltm}
          onOpen={() => {
            setSummaryOpen(false)
            setLtmOpen(false)
            setLayersTab('ltm')
            setLayersOpen(true)
          }}
        />
        {chatTimeline.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">💬</div>
            <div className="chat-empty-title">打个招呼吧</div>
            <div className="chat-empty-desc">发送第一条消息开始对话。同好友另起一段可输入 /new_chat。</div>
          </div>
        ) : (
          chatTimeline.map((item) => {
            if (item.kind !== 'message') return renderTimelineCard(item)
            const message = messages.find((entry) => entry.id === item.id)
            if (!message) return null
            const messageIndex = messages.findIndex((entry) => entry.id === item.id)
            const mine = message.role === 'user'
            const spokenBy = friends.find((friend) => friend.id === message.speakerFriendId) ?? speaker
            const who = mine ? '我' : spokenBy?.name ?? names[0] ?? '回复'
            const latestId = messages.at(-1)?.id
            const forceExpanded =
              message.id === latestId || message.status === 'streaming' || message.status === 'pending'
            const runEvents =
              message.runId && timelineByRun.get(message.runId)?.length
                ? timelineByRun.get(message.runId)!
                : null
            const isLastOfRun =
              Boolean(message.runId) &&
              messages.findLastIndex((item) => item.runId === message.runId) === messageIndex
            const trackAfter =
              isLastOfRun && runEvents ? (
                <ToolTrackBlock key={`track-${message.runId}`} events={runEvents} friends={friends} fallback={speaker} />
              ) : null
            if (message.kind === 'assign' || message.kind === 'result') {
              const assignment = assignments.find((item) => item.id === message.assignmentId)
              const target = friends.find((friend) => friend.id === assignment?.toFriendId)
              return (
                <Fragment key={message.id}>
                  <div className="msg">
                    <Avatar avatar={spokenBy?.avatar} name={who} size="sm" />
                    <div>
                      <div className="who">{message.kind === 'assign' ? `${who} · 指派任务` : `${who} · 任务结果`}</div>
                      {message.kind === 'assign' ? (
                        <AssignCard
                          assignment={assignment}
                          targetName={target?.name ?? '好友'}
                          onRetry={(id) => {
                            // 重试先清掉旧错误，轮询才会重新启动并显示进度。
                            setAssignments((current) =>
                              current.map((item) => (item.id === id ? { ...item, error: undefined } : item)),
                            )
                            void retryAssignment(id, setError)
                          }}
                        />
                      ) : (
                        <ResultCard assignment={assignment} content={message.content} />
                      )}
                    </div>
                  </div>
                  {trackAfter}
                </Fragment>
              )
            }
            const waiting = Boolean(active) && (message.status === 'pending' || message.status === 'streaming')
            const failed = message.status === 'error'
            return (
              <Fragment key={message.id}>
              <div
                className={`msg${mine ? ' msg-me' : ''}${waiting ? ' msg-pending' : ''}${failed ? ' msg-error' : ''}`}
              >
                {mine ? (
                  <span className="av me-av">我</span>
                ) : (
                  <Avatar avatar={spokenBy?.avatar ?? speaker?.avatar} name={who} size="sm" />
                )}
                <div className="msg-stack" style={mine ? { alignItems: 'flex-end' } : undefined}>
                  <div className="msg-who" style={mine ? { textAlign: 'right', paddingRight: 2 } : undefined}>
                    {who}
                    {message.status === 'pending' && active
                      ? ' · 等待中可终止'
                      : message.status === 'streaming' && active
                        ? ' · 生成中'
                        : failed
                          ? ' · 发送失败'
                          : ''}
                  </div>
                  {!mine && message.memoryInject ? (
                    <InjectSources
                      inject={message.memoryInject}
                      summary={summary}
                      ltm={ltm}
                      onPreview={setInjectPreviewSource}
                    />
                  ) : null}
                  {message.status === 'pending' && !message.content && !message.reasoning && active ? (
                    <div className="bubble">
                      <span className="typing" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span style={{ marginLeft: 8, color: '#888' }}>约 {sendWaitSeconds} 秒后调模型…</span>
                    </div>
                  ) : failed ? (
                    (() => {
                      const raw = (message.content || message.error || '').trim()
                      const placeholder = !raw || raw === '（空响应）' || raw === '(空响应)' || raw === '空响应'
                      return (
                        <>
                          {message.reasoning?.trim() ? (
                            <ThinkingBlock
                              messageId={message.id}
                              reasoning={message.reasoning}
                              streaming={false}
                            />
                          ) : null}
                          {!placeholder ? (
                            <CollapsibleBubble forceExpanded={forceExpanded} resetKey={message.id}>
                              <div className="bubble">{raw}</div>
                            </CollapsibleBubble>
                          ) : null}
                          <div className="chat-error-card">
                            <div className="err-title">连不上模型</div>
                            <div className="err-desc">
                              请检查提供方是否启用、Base URL 是否正确，以及本机服务是否已开。不要一直停在「等待中可终止」。
                            </div>
                            <div className="err-actions">
                              <button type="button" className="btn btn-sm" onClick={() => onOpenProviders?.()}>
                                去设置检查提供方
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  setSendFailed(false)
                                  setError('')
                                }}
                              >
                                返回聊天
                              </button>
                            </div>
                          </div>
                        </>
                      )
                    })()
                  ) : (
                    <>
                      {message.reasoning?.trim() ? (
                        <ThinkingBlock
                          messageId={message.id}
                          reasoning={message.reasoning}
                          streaming={Boolean(active) && message.status === 'streaming'}
                        />
                      ) : null}
                      <MessageBubbleBody
                        message={message}
                        forceExpanded={forceExpanded}
                        onOpenImage={(src) => setLightboxSrc(src)}
                      />
                    </>
                  )}
                </div>
              </div>
              {trackAfter}
              </Fragment>
            )
          })
        )}
        {extracting ? (
          <div className="extracting-pill" role="status">
            <span className="extracting-spin" aria-hidden="true" />
            正在从所选会话提炼技能…
          </div>
        ) : null}
        {skillExtractDrafts.map((draft) => (
          <div key={draft.id} className="msg msg-assistant">
            <SkillExtractCard
              draft={draft}
              friend={friends.find((item) => item.id === draft.friendId)}
              onDone={() => {
                void requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`).then((thread) => {
                  setMessages(thread.messages)
                  setSkillSuggestions(thread.skillSuggestions ?? [])
                  setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
                })
              }}
              onConfirmed={(skill, friendName) => {
                setNotice(`技能已挂到 ${friendName} · ${skill.name}`)
              }}
            />
          </div>
        ))}
        {skillSuggestions.map((suggestion) => (
          <div key={suggestion.id} className="msg">
            <Avatar avatar={speaker?.avatar} name={speaker?.name ?? '系统'} size="sm" />
            <div>
              <div className="who">{speaker?.name ?? '系统'} · 建议技能</div>
              <SkillSuggestCard
                suggestion={suggestion}
                friends={friends}
                onDone={() => {
                  void requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`).then((thread) => {
                    setSkillSuggestions(thread.skillSuggestions ?? [])
              setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
                  })
                }}
                onAccepted={(friendName, skillName) => setNotice(`已确认保存 · 挂到 ${friendName} · ${skillName}`)}
              />
            </div>
          </div>
        ))}
      </div>
      <form className="chat-ft" onSubmit={(event) => void onSend(event)}>
        <div className={`composer-toolbar${chatMode === 'plan' ? ' is-plan' : ''}`} role="toolbar" aria-label="会话设置栏">
          {current.kind !== 'group' ? (
          <div className="ctb-group" title="模型">
            <span className="ctb-label">模型</span>
            <button
              type="button"
              className="ctb-btn ctb-btn-model"
              aria-haspopup="listbox"
              aria-expanded={barModelMenu}
              onClick={(event) => {
                event.stopPropagation()
                setBarModelMenu((value) => !value)
                setModelMenu(false)
                setSessionsOpen(false)
              }}
            >
              <span>{modelLabel}</span>
              <span className="ctb-caret" aria-hidden="true">▾</span>
            </button>
            {barModelMenu ? (
              <div className="ctb-menu ctb-model-menu" role="listbox">
                {providers.filter((item) => item.enabled).flatMap((item) => {
                  const models = item.probedModels?.length
                    ? item.probedModels
                    : item.defaultModel
                      ? [item.defaultModel]
                      : []
                  return models.map((id) => {
                    const selected = (selectedProviderId ?? effectiveProvider?.id) === item.id && model === id
                    return (
                      <button
                        key={`${item.id}:${id}`}
                        type="button"
                        className={selected ? 'ctb-menu-item is-active' : 'ctb-menu-item'}
                        role="option"
                        onClick={() => chooseModel(item.id, id)}
                      >
                        {item.name} · {id}
                      </button>
                    )
                  })
                })}
                {onOpenProviders ? (
                  <button type="button" className="ctb-menu-link" onClick={() => onOpenProviders()}>
                    管理提供方…
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}
          <div className="ctb-group ctb-group-mode">
            <span className="ctb-label">对话模式</span>
            <div className="seg ctb-seg" role="tablist" aria-label="对话模式">
              {([
                ['normal', '普通'],
                ['plan', '计划模式'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={chatMode === value ? 'seg-btn is-active' : 'seg-btn'}
                  data-mode={value}
                  role="tab"
                  aria-selected={chatMode === value}
                  onClick={() => {
                    setChatMode(value)
                    void patchComposer({ chatMode: value })
                      .then(() => setNotice(value === 'plan' ? '计划模式：先写 MD，确认后执行' : '已切回普通模式'))
                      .catch((cause) => setError(cause instanceof Error ? cause.message : '模式未保存'))
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ctb-group ctb-group-reason">
            <span className="ctb-label">推理程度</span>
            <div className="seg ctb-seg" role="tablist" aria-label="推理程度">
              {([
                ['low', '低'],
                ['medium', '中'],
                ['high', '高'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={reasoningLevel === value ? 'seg-btn is-active' : 'seg-btn'}
                  role="tab"
                  aria-selected={reasoningLevel === value}
                  onClick={() => {
                    setReasoningLevel(value)
                    void patchComposer({ reasoningLevel: value })
                      .then(() => setNotice(`推理程度 · ${label}`))
                      .catch((cause) => setError(cause instanceof Error ? cause.message : '推理程度未保存'))
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ctb-right">
            <button type="button" className="ctb-btn" title="保存为技能（上方栏为主入口）" onClick={() => setSkillOpen(true)}>
              保存为技能
            </button>
            <button type="button" className="ctb-btn" title="同好友新开对话（/new_chat）" onClick={() => void startNewChat()}>
              新会话
            </button>
            <div className="ctb-group">
              <button
                type="button"
                className="ctb-btn"
                title={sessions.length > 1 ? '在本联系人的会话段之间切换' : '还没有别的会话段'}
                aria-haspopup="menu"
                aria-expanded={sessionsOpen}
                disabled={sessions.length <= 1}
                onClick={(event) => {
                  event.stopPropagation()
                  setBarModelMenu(false)
                  setSessionsOpen((value) => !value)
                }}
              >
                会话列表
                <span className="ctb-caret" aria-hidden="true">▾</span>
              </button>
              {sessionsOpen ? (
                <div className="ctb-menu ctb-session-menu" role="menu">
                  {[...sessions].reverse().map((session) => {
                    const index = sessions.findIndex((item) => item.id === session.id) + 1
                    const active = session.id === current.id
                    return (
                      <button
                        key={session.id}
                        type="button"
                        role="menuitem"
                        className={active ? 'ctb-menu-item ctb-session-item is-active' : 'ctb-menu-item ctb-session-item'}
                        onClick={() => {
                          setSessionsOpen(false)
                          if (!active) onSwitchConversation?.(session.id)
                        }}
                      >
                        <span className="ctb-session-row">
                          <span>
                            第 {index} 段{active ? ' · 当前' : ''}
                          </span>
                          <span className="ctb-session-time">{formatSegmentTime(session.createdAt)}</span>
                        </span>
                        <span className="ctb-session-preview">{session.preview || '还没有消息'}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="composer-wrap">
          {pendingAttachments.length > 0 ? (
            <div className="composer-previews" aria-label="待发送附件">
              {pendingAttachments.map((item) => (
                <div key={item.localId} className={`preview-chip${item.status === 'uploading' ? ' is-uploading' : ''}`}>
                  {item.kind === 'image' && item.previewUrl ? (
                    <img className="pv-thumb" src={item.previewUrl} alt="" />
                  ) : (
                    <div className="pv-file">{extLabel(item.name)}</div>
                  )}
                  <div className="pv-meta">
                    <div className="pv-name">{item.name}</div>
                    {item.status === 'uploading' ? (
                      <div className="pv-progress">上传中…</div>
                    ) : item.status === 'error' ? (
                      <div className="pv-progress">{item.error || '上传失败'}</div>
                    ) : (
                      <div className="pv-size">{formatSize(item.size)}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="pv-remove"
                    title="移除"
                    aria-label="移除"
                    onClick={() => {
                      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
                      setPendingAttachments((current) => current.filter((row) => row.localId !== item.localId))
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            className="composer"
            value={draft}
            aria-label="消息输入"
            placeholder={
              archivedChat
                ? '已归档，取消归档后才能继续聊天'
                : chatMode === 'plan'
                  ? '计划模式下先出 MD；确认「开始执行」后再跑步骤 · Enter 发送 · 可粘贴附件'
                  : current.kind === 'group'
                    ? '输入消息，Enter 发送 · 用 @ 直接找群友（不带之前的记忆）· 不 @ 由群主接'
                    : '输入消息，Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片/文件 · /new_chat 另起新对话'
            }
            disabled={archivedChat || Boolean(active) || pending}
            onChange={(event) => {
              const value = event.target.value
              setDraft(value)
              syncMentionMenu(value, event.target.selectionStart)
            }}
            onKeyDown={onComposerKey}
            onPaste={onComposerPaste}
          />
          {mentionMenu && mentionCandidates.length > 0 ? (
            <div className="mention-menu" role="listbox" aria-label="选择要 @ 的好友">
              <div className="mention-menu-hd">@ 好友 · 直接找 TA</div>
              {mentionCandidates.map((friend, index) => (
                <button
                  key={friend.id}
                  type="button"
                  role="option"
                  aria-selected={index === Math.min(mentionMenu.index, mentionCandidates.length - 1)}
                  className={index === Math.min(mentionMenu.index, mentionCandidates.length - 1) ? 'mention-item is-active' : 'mention-item'}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applyMention(friend)
                  }}
                >
                  <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                  <span className="mention-item-meta">
                    <span className="mention-item-name">
                      {friend.name}
                      {friend.isOwnerTemplate ? ' · 默认接话' : ''}
                    </span>
                    <span className="mention-item-desc">
                      {friend.workspacePath?.trim() ? '已绑工作目录' : '未绑工作目录'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {mentionToOther && mentionTarget ? (
          <p className="hint mention-hint">已点名 @{mentionTarget.friend.name} · 由 TA 直接回复，不带之前的记忆</p>
        ) : null}
        {notice && !active && !hintFailed ? <p className="hint">{notice}</p> : null}
        {error && !hintFailed ? <p className="form-error">{error}</p> : null}
        <div className="ft-row">
          <div className="ft-actions">
            <input
              ref={filePickerRef}
              type="file"
              accept="image/*,.pdf,.md,.txt,.diff,.zip,.doc,.docx,.png,.jpg,.jpeg,.webp,.gif"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length) void enqueueUploads(files)
              }}
            />
            <button
              type="button"
              className={`attach-btn${pendingAttachments.some((item) => item.status === 'uploading') ? ' is-busy' : ''}`}
              title="添加图片或附件（也可直接粘贴）"
              aria-label="添加图片或附件"
              disabled={archivedChat || Boolean(active) || pending}
              onClick={() => filePickerRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M16.5 6.5v9.25a4.5 4.5 0 1 1-9 0V6.75a3 3 0 1 1 6 0v8.5a1.5 1.5 0 1 1-3 0V7.25a.75.75 0 0 0-1.5 0v8a3 3 0 1 0 6 0V6.5a.75.75 0 0 0-1.5 0z"
                />
              </svg>
            </button>
            {current.kind === 'group' ? (
              <button type="button" className="ft-action" disabled={archivedChat} onClick={() => setAssignOpen(true)}>
                ＋ 指派给好友
              </button>
            ) : null}
            <span className={sendHintClass} id="sendHint">
              {sendHint}
            </span>
          </div>
          <button
            type={active ? 'button' : 'submit'}
            className={active ? 'btn btn-stop' : 'btn'}
            disabled={pending || (archivedChat && !active) || (!active && draft.trim().length === 0 && !pendingAttachments.some((item) => item.status === 'ready' && item.attachment))}
            onClick={active ? () => void onCancel() : undefined}
          >
            {active ? '终止' : '发送'}
          </button>
        </div>
      </form>
      {lightboxSrc ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) setLightboxSrc(null)
          }}
        >
          <button type="button" className="lightbox-close" aria-label="关闭" onClick={() => setLightboxSrc(null)}>
            ✕
          </button>
          <img src={lightboxSrc} alt="预览大图" />
        </div>
      ) : null}
      {skillOpen && current && speaker ? (
        <SaveSkillSessionsSheet
          conversationId={current.id}
          friend={speaker}
          messages={messages}
          friends={friends}
          providers={providers}
          extracting={extracting}
          onClose={() => setSkillOpen(false)}
          onExtracting={setExtracting}
          onStarted={async () => {
            setSkillOpen(false)
            setNotice('正在提炼技能草案…')
            const thread = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`)
            setMessages(thread.messages)
            setSkillSuggestions(thread.skillSuggestions ?? [])
            setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
            setExtracting(false)
            setNotice('技能草案已生成 · 请确认后才会挂到好友')
          }}
          onLegacySaved={(skill, friendName) => {
            setSkillOpen(false)
            setNotice(`技能已挂到 ${friendName} · ${skill.name}`)
          }}
        />
      ) : null}
      {assignOpen ? (
        <AssignSheet
          friends={friends.filter((friend) => current.friendIds.includes(friend.id) && !friend.isOwnerTemplate)}
          initial={draft}
          onClose={() => setAssignOpen(false)}
          onCreate={async (toFriendId, instruction) => {
            await requestJson(`/api/conversations/${encodeURIComponent(current.id)}/assignments`, {
              method: 'POST',
              body: JSON.stringify({ toFriendId, instruction }),
            })
            setAssignOpen(false)
            setNotice('已指派。结果会回流到这个群里。')
            const thread = await requestJson<ThreadPayload>(`/api/conversations/${encodeURIComponent(current.id)}/thread`)
            setMessages(thread.messages)
            setAssignments(thread.assignments)
            setSummary(thread.summary)
            setLtm(thread.longTermMemories)
            setSkillSuggestions(thread.skillSuggestions ?? [])
              setSkillExtractDrafts(thread.skillExtractDrafts ?? [])
          }}
        />
      ) : null}
    </main>
  )
}

function ConfirmCard({
  proposal,
  friends,
  onDone,
}: {
  proposal: Proposal
  friends: Friend[]
  onDone: () => void
}) {
  /** 未选作用域时确认禁用，对齐 propose.html */
  const [scope, setScope] = useState<'global' | 'friends' | 'groups' | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [groups, setGroups] = useState<Array<{ lineageId: string; title: string }>>([])
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const [error, setError] = useState(proposal.error ?? '')
  const [pending, setPending] = useState(false)
  const [phase, setPhase] = useState<'pending' | 'confirmed' | 'cancelled'>('pending')

  const isFriend = proposal.kind === 'friend'
  const isConfigKind =
    proposal.kind === 'provider' ||
    proposal.kind === 'app_settings' ||
    proposal.kind === 'friend_patch' ||
    proposal.kind === 'group' ||
    proposal.kind === 'vault_binding'
  const draftPrompt =
    typeof proposal.draft.systemPrompt === 'string'
      ? proposal.draft.systemPrompt
      : typeof proposal.draft.body === 'string'
        ? proposal.draft.body
        : ''
  const draftDesc =
    typeof proposal.draft.description === 'string' ? proposal.draft.description : proposal.summary
  const [friendName, setFriendName] = useState(proposal.name)
  const [friendPrompt, setFriendPrompt] = useState(draftPrompt)
  const [friendDesc, setFriendDesc] = useState(draftDesc)
  const draftDefaultModel =
    typeof proposal.draft.defaultModelId === 'string'
      ? proposal.draft.defaultModelId
      : typeof proposal.draft.model === 'string'
        ? proposal.draft.model
        : ''
  const [friendDefaultModel, setFriendDefaultModel] = useState(draftDefaultModel)
  const isMcp = proposal.kind === 'mcp'

  useEffect(() => {
    if (!isMcp) return
    let stop = false
    void requestJson<{ ok: true; conversations: ConversationCard[] }>('/api/workbench')
      .then((payload) => {
        if (stop) return
        setGroups(
          latestGroups(payload.conversations).map((item) => ({
            lineageId: groupLineage(item),
            title: item.title,
          })),
        )
      })
      .catch(() => {
        if (!stop) setGroups([])
      })
    return () => {
      stop = true
    }
  }, [isMcp])

  const meta =
    proposal.kind === 'task'
      ? { kindLabel: '自动化', icon: '⚡', title: '创建自动化任务', doneTitle: '已创建自动化任务', globalDesc: '任务定义对全部好友可见；运行仍由绑定好友执行' }
      : proposal.kind === 'mcp'
        ? { kindLabel: 'MCP', icon: '🔌', title: '启用 MCP', doneTitle: '已启用 MCP', globalDesc: 'MCP 对全部会话可用' }
        : proposal.kind === 'friend'
          ? { kindLabel: '好友', icon: '👤', title: '创建好友', doneTitle: '已创建好友', globalDesc: '写入通讯录；与「＋ 新建好友」并存' }
          : proposal.kind === 'provider'
            ? { kindLabel: '提供方', icon: '🔑', title: '写入提供方', doneTitle: '已写入提供方', globalDesc: '全局模型提供方' }
            : proposal.kind === 'app_settings'
              ? { kindLabel: '应用设置', icon: '⚙️', title: '写入应用设置', doneTitle: '已写入应用设置', globalDesc: '全局应用偏好' }
              : proposal.kind === 'friend_patch'
                ? { kindLabel: '好友补丁', icon: '👤', title: '更新好友', doneTitle: '已更新好友', globalDesc: '改已有好友资料' }
                : proposal.kind === 'group'
                  ? { kindLabel: '群组', icon: '👥', title: '写入群组', doneTitle: '已写入群组', globalDesc: '新建群或改成员' }
                  : proposal.kind === 'vault_binding'
                    ? { kindLabel: '保险库', icon: '🔐', title: '绑定保险库', doneTitle: '已绑定保险库', globalDesc: '密钥走保险库引用' }
                    : { kindLabel: 'Skill', icon: '✨', title: '创建技能', doneTitle: '已创建技能', globalDesc: '技能对全部好友可见' }

  const scopeValid =
    isFriend ||
    isConfigKind ||
    scope === 'global' ||
    (scope === 'friends' && picked.length >= 1) ||
    (isMcp && scope === 'groups' && pickedGroups.length >= 1)
  const friendValid = !isFriend || friendName.trim().length > 0
  const failed = Boolean(error) && phase === 'pending'

  async function confirm() {
    if (!scopeValid || !friendValid) return
    if (!isFriend && !isConfigKind && !scope) return
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/proposals/${encodeURIComponent(proposal.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify(
          isFriend
            ? {
                scope: 'global',
                friendIds: [],
                name: friendName.trim(),
                description: friendDesc,
                systemPrompt: friendPrompt,
                defaultModelId: friendDefaultModel.trim(),
              }
            : isConfigKind
              ? { scope: 'global', friendIds: [] }
              : {
                  scope,
                  friendIds: scope === 'friends' ? picked : [],
                  groupIds: scope === 'groups' ? pickedGroups : [],
                },
        ),
      })
      setPhase('confirmed')
      window.setTimeout(() => onDone(), 700)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有写入，可以再试一次')
    } finally {
      setPending(false)
    }
  }

  async function cancel() {
    setPending(true)
    try {
      await requestJson(`/api/proposals/${encodeURIComponent(proposal.id)}/cancel`, { method: 'POST' })
      setPhase('cancelled')
      window.setTimeout(() => onDone(), 700)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败')
    } finally {
      setPending(false)
    }
  }

  if (phase === 'confirmed') {
    const scopeLabel = isFriend
      ? '已写入通讯录'
      : isConfigKind
        ? '全局配置'
        : scope === 'global'
          ? '全局'
          : scope === 'groups'
            ? `指定群 · ${groups
                .filter((group) => pickedGroups.includes(group.lineageId))
                .map((group) => group.title)
                .join('、')}`
            : `指定好友 · ${friends
                .filter((friend) => picked.includes(friend.id))
                .map((friend) => friend.name)
                .join('、')}`
    return (
      <div className="msg">
        <div>
          <div className="confirm-card is-done" role="status" aria-label="已创建">
            <div className="confirm-card-hd">
              <div className="cc-icon">✓</div>
              <div>
                <div className="cc-kind">{meta.kindLabel}</div>
                <div className="cc-title">{meta.doneTitle}</div>
                <div className="cc-sub">
                  {isFriend ? friendName.trim() || proposal.name : proposal.name} · {scopeLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'cancelled') {
    return (
      <div className="msg">
        <div>
          <div className="confirm-card is-cancelled" role="status" aria-label="已取消">
            <div className="confirm-card-hd">
              <div className="cc-icon">–</div>
              <div>
                <div className="cc-kind">{meta.kindLabel}</div>
                <div className="cc-title">已取消</div>
                <div className="cc-sub">{proposal.name} · 草稿已丢弃 · 无落库</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg">
      <div>
        <div
          className={failed ? 'confirm-card is-failed' : 'confirm-card'}
          role="group"
          aria-label={`提议创建${meta.kindLabel}`}
          data-status="pending"
          data-kind={proposal.kind}
          data-proposal-id={proposal.id}
        >
          <div className="confirm-card-hd">
            <div className="cc-icon">{failed ? '!' : meta.icon}</div>
            <div>
              <div className="cc-kind">{meta.kindLabel}</div>
              <div className="cc-title">{failed ? (proposal.kind === 'mcp' ? '启用未完成' : '创建未完成') : meta.title}</div>
              <div className="cc-sub">
                {failed
                  ? `${proposal.name} · 整笔已回滚 · 仍为 pending 可重试`
                  : `${proposal.name}${proposal.summary && proposal.summary !== proposal.name ? ` · ${proposal.summary}` : ''} · 未确认不落库`}
              </div>
            </div>
          </div>
          <div className="confirm-card-bd">
            {isConfigKind ? (
              <>
                <ConfigProposalBody proposal={proposal} friends={friends} />
                <p className="friend-only-note">配置变更无需作用域：确认落库 / 取消不写。设置页仍保留作对照。</p>
              </>
            ) : isFriend ? (
              <div className="propose-friend-fields">
                <label className="friend-propose-label">
                  名称
                  <input
                    className="search-input"
                    value={friendName}
                    onChange={(event) => setFriendName(event.target.value)}
                    placeholder="好友显示名"
                    disabled={pending}
                  />
                </label>
                <label className="friend-propose-label">
                  简介
                  <input
                    className="search-input"
                    value={friendDesc}
                    onChange={(event) => setFriendDesc(event.target.value)}
                    placeholder="一句话简介（可选）"
                    disabled={pending}
                  />
                </label>
                <label className="friend-propose-label">
                  人设
                  <textarea
                    className="composer"
                    rows={4}
                    value={friendPrompt}
                    onChange={(event) => setFriendPrompt(event.target.value)}
                    placeholder="系统提示 / 人设（可选）"
                    disabled={pending}
                    style={{ minHeight: 88 }}
                  />
                </label>
                <label className="friend-propose-label">
                  默认模型（可选）
                  <input
                    className="search-input"
                    value={friendDefaultModel}
                    onChange={(event) => setFriendDefaultModel(event.target.value)}
                    placeholder="如 deepseek-chat；可留空"
                    disabled={pending}
                    aria-label="默认模型"
                  />
                </label>
                <p className="confirm-note">确认后写入通讯录；「＋ 新建好友」入口仍保留。</p>
              </div>
            ) : (
              <>
                {proposal.summary && proposal.summary !== proposal.name ? (
                  <div className="propose-fields">
                    <div className="inset-section-title" style={{ marginTop: 2 }}>
                      摘要
                    </div>
                    <p className="propose-summary">{proposal.summary}</p>
                  </div>
                ) : null}
                <div className="confirm-q">这笔设置给谁？</div>
                <div className="scope-options">
                  <button
                    type="button"
                    className={scope === 'global' ? 'scope-opt is-selected' : 'scope-opt'}
                    aria-pressed={scope === 'global'}
                    onClick={() => setScope('global')}
                  >
                    <span className="radio" aria-hidden="true" />
                    <span>
                      <div className="opt-title">全局（所有好友可用）</div>
                      <div className="opt-desc">{meta.globalDesc}</div>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={scope === 'friends' ? 'scope-opt is-selected' : 'scope-opt'}
                    aria-pressed={scope === 'friends'}
                    onClick={() => setScope('friends')}
                  >
                    <span className="radio" aria-hidden="true" />
                    <span>
                      <div className="opt-title">指定好友</div>
                      <div className="opt-desc">仅勾选的好友可用 · 至少选 1 人</div>
                    </span>
                  </button>
                  {isMcp ? (
                    <button
                      type="button"
                      className={scope === 'groups' ? 'scope-opt is-selected' : 'scope-opt'}
                      aria-pressed={scope === 'groups'}
                      onClick={() => setScope('groups')}
                    >
                      <span className="radio" aria-hidden="true" />
                      <span>
                        <div className="opt-title">指定群聊</div>
                        <div className="opt-desc">仅勾选的群可用 · 群里谁发言都能调用</div>
                      </span>
                    </button>
                  ) : null}
                </div>
                {scope === 'friends' ? (
                  <div className="friend-multi is-open" aria-label="选择好友">
                    {friends.map((friend) => (
                      <button
                        key={friend.id}
                        type="button"
                        className={picked.includes(friend.id) ? 'friend-multi-item is-checked' : 'friend-multi-item'}
                        onClick={() =>
                          setPicked((current) =>
                            current.includes(friend.id) ? current.filter((id) => id !== friend.id) : [...current, friend.id],
                          )
                        }
                      >
                        <span className="check" />
                        <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                        {friend.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                {isMcp && scope === 'groups' ? (
                  <div className="friend-multi is-open" aria-label="选择群聊">
                    {groups.length === 0 ? <p className="help">还没有群聊。先发起群，再挂到这个群。</p> : null}
                    {groups.map((group) => (
                      <button
                        key={group.lineageId}
                        type="button"
                        className={pickedGroups.includes(group.lineageId) ? 'friend-multi-item is-checked' : 'friend-multi-item'}
                        onClick={() =>
                          setPickedGroups((current) =>
                            current.includes(group.lineageId)
                              ? current.filter((id) => id !== group.lineageId)
                              : [...current, group.lineageId],
                          )
                        }
                      >
                        <span className="check" />
                        {group.title}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
            {failed ? <p className="confirm-error">proposal.error：{error}</p> : null}
            <p className="confirm-note">
              模型工具 <code>workbench_propose</code> 仅 stage · status=pending 不落库 · 确认才写。p1.4 扩展
              provider|app_settings|friend_patch|group|vault_binding。≠ 系统建议技能 / ≠ MCP 市场启用。
            </p>
          </div>
          <div className="confirm-card-ft">
            <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void cancel()}>
              取消
            </button>
            <button type="button" className="btn btn-sm" disabled={pending || !scopeValid || !friendValid} onClick={() => void confirm()}>
              {pending ? '写入中' : failed ? '重试' : isConfigKind || isFriend ? '确认落库' : '确认'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 把会话 id 放进剪贴板，便于拿到别的地方对照本地会话数据。 */
async function copyConversationId(conversationId: string): Promise<void> {
  if (navigator.clipboard?.writeText && document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(conversationId)
      return
    } catch {
      // 页面未获剪贴板权限时改走选区复制。
    }
  }
  const area = document.createElement('textarea')
  area.value = conversationId
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.append(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('复制失败')
}

function flashCopyState(setCopyState: (value: 'idle' | 'ok' | 'fail') => void, value: 'ok' | 'fail') {
  setCopyState(value)
  window.setTimeout(() => setCopyState('idle'), 1200)
}

async function regenerateSummary(
  conversationId: string,
  setSummary: (summary: Summary | null) => void,
  setError: (message: string) => void,
  setPending: (value: boolean) => void,
): Promise<Summary | null> {
  setPending(true)
  setError('')
  try {
    const payload = await requestJson<{ ok: true; summary: Summary }>(`/api/conversations/${encodeURIComponent(conversationId)}/summary`, {
      method: 'POST',
    })
    setSummary(payload.summary)
    return payload.summary
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : '没有生成摘要')
    return null
  } finally {
    setPending(false)
  }
}

async function keepSummary(
  conversationId: string,
  setSummary: (summary: Summary | null) => void,
  setError: (message: string) => void,
  setPending: (value: boolean) => void,
  onDone: () => void,
) {
  setPending(true)
  setError('')
  try {
    const payload = await requestJson<{ ok: true; summary: Summary }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/summary/inject`,
      { method: 'POST' },
    )
    setSummary(payload.summary)
    onDone()
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : '没有注入')
  } finally {
    setPending(false)
  }
}

async function retryAssignment(id: string, setError: (message: string) => void) {
  try {
    await requestJson(`/api/assignments/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : '没有重试')
  }
}

function SummaryPanel({
  summary,
  pending,
  onClose,
  onGenerate,
  onInject,
}: {
  summary: Summary | null
  pending: boolean
  onClose: () => void
  onGenerate: () => void
  onInject: () => void
}) {
  const when = summary ? new Date(summary.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  return (
    <div className="summary-panel is-open" role="dialog" aria-label="事件摘要">
      <div className="summary-panel-hd">
        <h3>事件摘要</h3>
        {summary?.injectOnNextTurn ? <span className="tag tag-ok">写入记忆</span> : <span className="tag">尚未注入</span>}
        <button type="button" className="panel-close" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="summary-panel-bd">
        <div className="summary-meta">
          <span>{summary ? `${summary.source === 'manual' ? '手动生成' : '自动生成'} · ${when}` : '还没有摘要'}</span>
          {summary?.injectOnNextTurn ? <span className="tag">注入后续回合</span> : null}
          <span className="tag">≤1000 字硬顶</span>
        </div>
        <p className="ltm-help" style={{ margin: '0 0 8px' }}>增量改写事件，非原文拼接。</p>
        <div className="summary-body">
          {summary ? <p style={{ whiteSpace: 'pre-wrap' }}>{summary.content}</p> : <p>点「手动生成摘要」，把这段对话收成事件摘要。</p>}
        </div>
      </div>
      <div className="summary-panel-ft">
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={onGenerate}>
          手动生成摘要
        </button>
        <button type="button" className="btn btn-sm" disabled={pending || !summary} onClick={onInject}>
          保留并注入
        </button>
      </div>
    </div>
  )
}

function AssignCard({
  assignment,
  targetName,
  onRetry,
}: {
  assignment: Assignment | undefined
  targetName: string
  onRetry: (id: string) => void
}) {
  const pending = assignment?.status === 'pending'
  return (
    <div className="assign-card" role="group" aria-label="指派任务给好友">
      <div className="assign-card-hd">
        <div className="ac-icon">指</div>
        <div>
          <div className="ac-title">指派给 · {targetName}</div>
          <div className="ac-sub">群主发起 · 结果回流本群</div>
        </div>
        <span className={pending ? 'assign-status pending' : 'assign-status done'} style={{ marginLeft: 'auto' }}>
          {assignment?.status === 'done' ? '已完成' : assignment?.status === 'cancelled' ? '已取消' : '进行中'}
        </span>
      </div>
      <div className="assign-card-bd">
        <div className="assign-task-text">{assignment?.instruction}</div>
        <div className="assign-to">
          <span>@{targetName}</span>
        </div>
        {pending && assignment?.progress ? (
          <div className="assign-progress" role="status">
            <span className="assign-spin" aria-hidden="true" />
            <span>{assignment.progress}</span>
          </div>
        ) : null}
        {assignment?.error ? <p className="form-error">{assignment.error}</p> : null}
      </div>
      <div className="assign-card-ft">
        <button type="button" className="btn btn-secondary btn-sm" disabled>
          {pending ? '已送达' : '已结束'}
        </button>
        {assignment?.error && pending ? (
          <button type="button" className="btn btn-sm" onClick={() => onRetry(assignment.id)}>
            重试
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled>
            {pending ? '等待结果' : '已回流'}
          </button>
        )}
      </div>
    </div>
  )
}

function ResultCard({ assignment, content }: { assignment: Assignment | undefined; content: string }) {
  // 历史消息里可能存过原始工具调用文本，展示时兜底收口。
  const text = sanitizeAssignmentText(content)
  return (
    <div className="result-card" role="article" aria-label="指派结果回流">
      <div className="result-card-hd">
        <span className="assign-status done">已完成</span>
        <span>回流自指派</span>
        {assignment?.steps ? <span className="assign-steps">执行 {assignment.steps} 步</span> : null}
      </div>
      <div className="result-card-bd">
        <div className="result-ref">对应指派：{assignment?.instruction ?? ''}</div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
      </div>
    </div>
  )
}

function stepsFromMessages(messages: Message[]): string[] {
  const steps: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.kind) continue
    const parts = message.content
      .split(/\n|；|;/)
      .map((part) => part.replace(/^\s*\d+[、.]\s*/, '').trim())
      .filter((part) => part.length > 1)
    steps.push(...parts)
  }
  return steps.slice(-6)
}

function formatSessionTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86400_000) return `${Math.max(1, Math.round(diff / 3600_000))} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

type FriendSessionPick = {
  id: string
  title: string
  preview: string
  updatedAt: number
  isCurrent: boolean
}

function SaveSkillSessionsSheet({
  conversationId,
  friend,
  messages,
  friends,
  providers,
  extracting,
  onClose,
  onExtracting,
  onStarted,
  onLegacySaved,
}: {
  conversationId: string
  friend: Friend
  messages: Message[]
  friends: Friend[]
  providers: PublicProvider[]
  extracting: boolean
  onClose: () => void
  onExtracting: (v: boolean) => void
  onStarted: () => Promise<void>
  onLegacySaved: (skill: Skill, friendName: string) => void
}) {
  const [sessions, setSessions] = useState<FriendSessionPick[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set([conversationId]))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [legacyOpen, setLegacyOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void requestJson<{ ok: true; sessions: FriendSessionPick[] }>(
      `/api/friends/${encodeURIComponent(friend.id)}/skill-sessions?currentConversationId=${encodeURIComponent(conversationId)}`,
    )
      .then((payload) => {
        if (cancelled) return
        setSessions(payload.sessions)
        const ids = new Set<string>()
        if (payload.sessions.some((item) => item.id === conversationId)) ids.add(conversationId)
        setSelected(ids)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '加载会话失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [friend.id, conversationId])

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function start() {
    if (selected.size === 0 || pending || extracting) return
    setPending(true)
    setError('')
    onExtracting(true)
    try {
      await requestJson('/api/skill-extracts', {
        method: 'POST',
        body: JSON.stringify({
          targetConversationId: conversationId,
          friendId: friend.id,
          sourceConversationIds: [...selected],
        }),
      })
      await onStarted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提炼失败')
      onExtracting(false)
      setPending(false)
    }
  }

  if (legacyOpen) {
    return (
      <LegacySkillSheet
        messages={messages}
        friends={friends}
        providers={providers}
        preferredId={friend.id}
        onClose={onClose}
        onSaved={onLegacySaved}
      />
    )
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet sheet-sessions" role="dialog" aria-modal="true" aria-labelledby="sessionSheetTitle">
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-hd">
          <button type="button" className="sheet-side leading" onClick={onClose}>
            取消
          </button>
          <h2 id="sessionSheetTitle">选择会话</h2>
          <button
            type="button"
            className={selected.size === 0 || pending || extracting ? 'sheet-side trailing is-disabled' : 'sheet-side trailing'}
            disabled={selected.size === 0 || pending || extracting}
            onClick={() => void start()}
          >
            {pending || extracting ? '提炼中…' : '开始总结'}
          </button>
        </div>
        <div className="sheet-bd">
          <p className="sheet-friend-hint">
            当前好友 · <strong>{friend.name}</strong> · 仅本好友会话（不可跨好友混选）
          </p>
          {loading ? <p className="help">加载会话列表…</p> : null}
          {!loading && sessions.length === 0 ? (
            <div className="session-pick-empty">
              <div className="empty-illu" aria-hidden="true">
                💬
              </div>
              <div className="empty-title">还没有可总结的会话</div>
              <div className="empty-desc">先和这位好友聊几轮，或另起一段对话后再来抽技能。</div>
            </div>
          ) : null}
          {!loading && sessions.length > 0 ? (
            <>
              <div className="session-pick-toolbar">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSelected(new Set(sessions.map((item) => item.id)))}
                >
                  全选
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                  清空
                </button>
                <span className="hint" style={{ marginLeft: 'auto' }}>
                  已选 {selected.size} 个
                </span>
              </div>
              <div className="session-pick-list" aria-label="本好友会话">
                {sessions.map((item) => {
                  const checked = selected.has(item.id)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={checked ? 'session-pick-item is-checked' : 'session-pick-item'}
                      onClick={() => toggle(item.id)}
                    >
                      <span className="check" aria-hidden="true" />
                      <span className="session-pick-meta">
                        <span className="session-pick-row1">
                          <span className="session-pick-title">{item.title}</span>
                          {item.isCurrent ? <span className="session-current-badge">当前</span> : null}
                          <span className="session-pick-time">{formatSessionTime(item.updatedAt)}</span>
                        </span>
                        <span className="session-pick-preview">{item.preview}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}
          <p className="inset-hint" style={{ marginTop: 14 }}>
            确认「开始总结」后，会把所选会话交给当前好友模型抽成通用技能草案；确认卡确认前不落库。
          </p>
          <details style={{ marginTop: 8 }}>
            <summary className="help" style={{ cursor: 'pointer' }}>
              改用本会话步骤手工保存（旧入口）
            </summary>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setLegacyOpen(true)}>
              打开旧版 sheet
            </button>
          </details>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}

function LegacySkillSheet({
  messages,
  friends,
  providers,
  preferredId,
  onClose,
  onSaved,
}: {
  messages: Message[]
  friends: Friend[]
  providers: PublicProvider[]
  preferredId?: string
  onClose: () => void
  onSaved: (skill: Skill, friendName: string) => void
}) {
  const preview = stepsFromMessages(messages)
  const [name, setName] = useState(preview[0]?.slice(0, 24) || '未命名技能')
  const [friendId, setFriendId] = useState(preferredId || friends[0]?.id || '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function confirm() {
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; skill: Skill }>('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name, friendId, steps: preview.length > 0 ? preview : [name] }),
      })
      const friend = friends.find((item) => item.id === friendId)
      onSaved(payload.skill, friend?.name ?? '好友')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有保存')
      setPending(false)
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="本会话步骤保存为技能（旧）">
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-hd">
          <button type="button" className="sheet-side leading" onClick={onClose}>
            取消
          </button>
          <h2>本会话步骤（旧）</h2>
          <button type="button" className="sheet-side trailing" disabled={pending} onClick={() => void confirm()}>
            确认
          </button>
        </div>
        <div className="sheet-bd">
          <div className="inset-section-title">名称</div>
          <div className="inset-group" style={{ marginBottom: 18 }}>
            <label className="inset-row">
              <input aria-label="技能名称" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>
          <div className="inset-section-title">步骤预览（来自本段对话）</div>
          <ol className="steps-preview" style={{ marginBottom: 18 }}>
            {(preview.length > 0 ? preview : ['这段对话里还没有可拆的步骤']).map((step, index) => (
              <li key={`${index}-${step}`}>
                <span className="step-n">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="inset-section-title">挂到哪个好友</div>
          <div className="friend-pick-list">
            {friends.map((friend) => {
              const provider = providers.find((item) => item.id === friend.providerId)
              const selected = friend.id === friendId
              return (
                <button
                  key={friend.id}
                  type="button"
                  className={selected ? 'friend-pick-item is-selected' : 'friend-pick-item'}
                  onClick={() => setFriendId(friend.id)}
                >
                  <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                  <span style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{friend.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {provider?.name ?? '未绑定'}
                      {friend.defaultModelId ? ` · ${friend.defaultModelId}` : ''}
                    </div>
                  </span>
                  <span className="radio" />
                </button>
              )
            })}
          </div>
          <p className="inset-hint">确认后技能挂到所选好友；可在好友编辑页「已挂技能」查看。未确认不落库。</p>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}

function AssignSheet({
  friends,
  initial,
  onClose,
  onCreate,
}: {
  friends: Friend[]
  initial: string
  onClose: () => void
  onCreate: (toFriendId: string, instruction: string) => Promise<void>
}) {
  const [instruction, setInstruction] = useState(initial)
  const [friendId, setFriendId] = useState(friends[0]?.id ?? '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const selectedFriend = friends.find((friend) => friend.id === friendId)

  async function submit() {
    setPending(true)
    setError('')
    try {
      await onCreate(friendId, instruction)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有指派')
      setPending(false)
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="指派任务">
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-hd">
          <button type="button" className="sheet-side leading" onClick={onClose}>
            取消
          </button>
          <h2>指派任务</h2>
          <button type="button" className="sheet-side trailing" disabled={pending || friends.length === 0} onClick={() => void submit()}>
            指派
          </button>
        </div>
        <div className="sheet-bd">
          <div className="inset-section-title">任务说明</div>
          <div className="inset-group" style={{ marginBottom: 18 }}>
            <label className="inset-row">
              <textarea
                aria-label="任务说明"
                value={instruction}
                placeholder="写清要对方完成什么…"
                onChange={(event) => setInstruction(event.target.value)}
                style={{ width: '100%', minHeight: 72, border: 0, background: 'transparent', resize: 'vertical' }}
              />
            </label>
          </div>
          <div className="inset-section-title">指派给（群内好友）</div>
          <div className="friend-pick-list">
            {friends.map((friend) => (
              <button
                key={friend.id}
                type="button"
                className={friend.id === friendId ? 'friend-pick-item is-selected' : 'friend-pick-item'}
                onClick={() => setFriendId(friend.id)}
              >
                <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                <span style={{ flex: 1 }}>{friend.name}</span>
                <span className="radio" />
              </button>
            ))}
          </div>
          <p className="inset-hint">仅群主可指派。成员完成后结果以卡片回流本群线程。</p>
          {selectedFriend && !selectedFriend.workspacePath?.trim() ? (
            <p className="inset-hint">
              {selectedFriend.name} 还没绑定工作目录：本次只能出方案，不能读写代码。要真正开发，先到好友资料里选择工作目录。
            </p>
          ) : null}
          {friends.length === 0 ? <p className="form-error">群里还没有可以指派的好友。建群时把群主和其他好友一起选上。</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}


type PendingAttachment = {
  localId: string
  name: string
  size: number
  kind: 'image' | 'file'
  previewUrl?: string
  status: 'uploading' | 'ready' | 'error'
  attachment?: MessageAttachment
  error?: string
}

function extLabel(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name || '')
  return (match?.[1] || 'FILE').toUpperCase().slice(0, 4)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 单次 run 的工具轨迹卡片；标题跟实际调用好友，不一律写成群主。 */
function ToolTrackBlock({
  events,
  friends,
  fallback,
}: {
  events: CodeToolTimelineEntry[]
  friends: Friend[]
  fallback?: Friend
}) {
  const friendIds = [...new Set(events.map((entry) => entry.friendId).filter(Boolean))]
  const friend =
    friendIds.length === 1 ? friends.find((item) => item.id === friendIds[0]) : undefined
  const name = friendIds.length > 1 ? '好友' : friend?.name ?? fallback?.name ?? '编码'
  return (
    <div className="msg">
      <Avatar avatar={friend?.avatar ?? fallback?.avatar} name={name} size="sm" />
      <div>
        <div className="who">{name} · 工具轨迹</div>
        <CodeToolTimeline events={events} />
      </div>
    </div>
  )
}

/** 折叠上限：14px × 1.45 × 3 行正文 + 上下 padding 8px。 */
const BUBBLE_COLLAPSE_MAX_PX = 14 * 1.45 * 3 + 16

/**
 * 历史气泡超过约三行则折叠；forceExpanded（最后一条 / 流式）始终展开。
 * 手动展开在 resetKey 变化或重新成为强制展开时复位。
 */
function CollapsibleBubble({
  forceExpanded,
  resetKey,
  children,
}: {
  forceExpanded: boolean
  resetKey: string
  children: ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    setManualOpen(false)
  }, [resetKey])

  useEffect(() => {
    if (forceExpanded) setManualOpen(false)
  }, [forceExpanded])

  const expanded = forceExpanded || manualOpen

  useLayoutEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const bubble = root.querySelector('.bubble') as HTMLElement | null
    if (!bubble) return

    const measure = () => {
      setOverflows(bubble.scrollHeight > BUBBLE_COLLAPSE_MAX_PX + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bubble)
    return () => observer.disconnect()
  }, [children, expanded, resetKey])

  const collapsed = !expanded && overflows

  return (
    <div
      ref={wrapRef}
      className={`bubble-collapse${expanded ? ' is-expanded' : ''}${collapsed ? ' is-collapsed' : ''}`}
    >
      <div className="bubble-collapse-clip">
        {children}
        {collapsed ? <div className="bubble-collapse-fade" aria-hidden="true" /> : null}
      </div>
      {!forceExpanded && overflows ? (
        <button
          type="button"
          className="bubble-collapse-toggle"
          aria-expanded={expanded}
          onClick={() => setManualOpen((value) => !value)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </div>
  )
}

function MessageBubbleBody({
  message,
  forceExpanded,
  onOpenImage,
}: {
  message: Message
  forceExpanded: boolean
  onOpenImage: (src: string) => void
}) {
  const attachments = message.attachments ?? []
  const text = message.content || ''
  if (attachments.length === 0) {
    if (!text) {
      // 流式仅有 reasoning 时不占空气泡；正式正文出来后再渲染
      if (message.status === 'streaming' && message.reasoning?.trim()) return null
      if (message.status === 'streaming') return <div className="bubble">正在写…</div>
      return null
    }
    return (
      <CollapsibleBubble forceExpanded={forceExpanded} resetKey={message.id}>
        <div className="bubble markdown bubble-md">
          <MarkdownText text={text} />
        </div>
      </CollapsibleBubble>
    )
  }
  const images = attachments.filter((item) => item.kind === 'image')
  const files = attachments.filter((item) => item.kind !== 'image')
  return (
    <CollapsibleBubble forceExpanded={forceExpanded} resetKey={message.id}>
      <div className="bubble bubble-with-media">
        <div className="bubble-media">
          {images.length > 1 ? (
            <div className="bubble-img-row">
              {images.map((item) => (
                <img
                  key={item.id}
                  className="bubble-img"
                  src={item.path}
                  alt={item.name}
                  data-lightbox=""
                  onClick={() => onOpenImage(item.path)}
                />
              ))}
            </div>
          ) : (
            images.map((item) => (
              <img
                key={item.id}
                className="bubble-img"
                src={item.path}
                alt={item.name}
                data-lightbox=""
                onClick={() => onOpenImage(item.path)}
              />
            ))
          )}
          {files.map((item) => (
            <div key={item.id} className="attach-card" role="group" aria-label={`附件 ${item.name}`}>
              <div className="ac-icon">{extLabel(item.name)}</div>
              <div className="ac-meta">
                <div className="ac-name">{item.name}</div>
                <div className="ac-size">{formatSize(item.size)}</div>
              </div>
              <a className="ac-dl" href={`${item.path}?download=1`} title="下载" aria-label="下载">
                ↓
              </a>
            </div>
          ))}
          {text ? (
            <div className="bubble-caption markdown bubble-md">
              <MarkdownText text={text} />
            </div>
          ) : null}
        </div>
      </div>
    </CollapsibleBubble>
  )
}

const THINK_CHEVRON = (
  <svg viewBox="0 0 10 10">
    <path
      fill="currentColor"
      d="M3.2 1.2a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5A.75.75 0 0 1 3.2 8.2L6.05 5.35 3.2 2.5a.75.75 0 0 1 0-1.3z"
    />
  </svg>
)

/** 有 reasoning 才渲染；默认折叠；流式中展开并标「正在思考…」。 */
function ThinkingBlock({
  messageId,
  reasoning,
  streaming,
}: {
  messageId: string
  reasoning: string
  streaming: boolean
}) {
  const [open, setOpen] = useState(streaming)
  const bodyId = `think-${messageId}`
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (streaming) {
      setOpen(true)
      wasStreaming.current = true
      return
    }
    if (wasStreaming.current) {
      setOpen(false)
      wasStreaming.current = false
    }
  }, [streaming])
  const expanded = streaming || open
  return (
    <div
      className={`thinking-block${streaming ? ' is-streaming' : ''}${expanded ? ' is-open' : ''}`}
      data-open={expanded ? '1' : '0'}
    >
      <button
        className="thinking-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => {
          if (streaming) return
          setOpen((value) => !value)
        }}
      >
        <span className="thinking-chevron" aria-hidden="true">
          {THINK_CHEVRON}
        </span>
        <span className="thinking-label">
          {streaming ? (
            <>
              正在思考<span className="thinking-dots">…</span>
            </>
          ) : expanded ? (
            '思考过程'
          ) : (
            '已思考'
          )}
        </span>
      </button>
      <div className="thinking-body" id={bodyId} role="region" aria-label="思考过程">
        {reasoning}
      </div>
    </div>
  )
}


function formatSegmentTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
