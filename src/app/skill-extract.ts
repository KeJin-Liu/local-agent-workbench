/**
 * p1.3：从所选会话抽通用技能。确认前不写 skills；作用域固定当前好友。
 * 不改 p0.4 建议技能 / p0.8 propose 主路径。
 */

import type { Friend, Skill, SkillExtractDraft } from '../domain/types.ts'
import { chat, type ChatMessage } from '../llm/client.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import {
  DEFAULT_SKILL_EXTRACT_PROMPT,
  normalizeSkillExtractPrompt,
} from '../storage/schema.ts'
import { AppError } from './errors.ts'
import { saveSkillForFriend } from './skills.ts'

export { DEFAULT_SKILL_EXTRACT_PROMPT, normalizeSkillExtractPrompt }

/** 近 N 条消息硬顶（优先摘要时仍截断气泡）。 */
export const EXTRACT_RECENT_MESSAGE_LIMIT = 24
/** 单会话拼进提示的大约字符顶。 */
export const EXTRACT_SESSION_CHAR_BUDGET = 3500

export type FriendSessionPick = {
  id: string
  title: string
  preview: string
  updatedAt: number
  isCurrent: boolean
}

export type SkillDraftParsed = {
  name: string
  scenario: string
  steps: string[]
  body: string
}

export type SkillExtractChatFn = (input: {
  friend: Friend
  systemPrompt: string
  userContent: string
}) => Promise<string>

export type StartSkillExtractInput = {
  /** 当前打开的会话：草案气泡写到这里。 */
  targetConversationId: string
  friendId: string
  sourceConversationIds: string[]
  /** 设置里的抽技能提示；空则默认。 */
  skillExtractPrompt?: string
  chatFn?: SkillExtractChatFn
}

/** 该好友下的单聊会话（含 lineage 多线程）；不含跨好友群混选。 */
export async function listFriendSessionsForSkill(
  repos: Repos,
  friendId: string,
  currentConversationId?: string,
): Promise<FriendSessionPick[]> {
  const friend = await repos.friends.get(friendId)
  if (!friend) throw new AppError(404, '找不到这个好友')
  const conversations = await repos.conversations.list()
  const mine = conversations
    .filter((item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === friendId)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh'))

  const picks: FriendSessionPick[] = []
  for (const conversation of mine) {
    const messages = await repos.messages.listByConversation(conversation.id)
    const last = [...messages].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]
    const summary = await repos.summaries.latest(conversation.id)
    const preview =
      (summary?.content ?? '').trim().slice(0, 80) ||
      (last?.content ?? '').trim().slice(0, 80) ||
      '（尚无消息）'
    picks.push({
      id: conversation.id,
      title: conversation.title || '未命名会话',
      preview,
      updatedAt: conversation.updatedAt,
      isCurrent: conversation.id === currentConversationId,
    })
  }
  picks.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.updatedAt - a.updatedAt)
  return picks
}

/** 拼所选会话上下文：优先摘要，再近 N 条。 */
export async function buildExtractUserContent(
  repos: Repos,
  sourceConversationIds: string[],
): Promise<string> {
  const parts: string[] = []
  for (const id of sourceConversationIds) {
    const conversation = await repos.conversations.get(id)
    if (!conversation) continue
    const summary = await repos.summaries.latest(id)
    const messages = (await repos.messages.listByConversation(id))
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .filter((item) => item.status !== 'error')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const recent = messages.slice(-EXTRACT_RECENT_MESSAGE_LIMIT)
    const header = '## 会话：' + (conversation.title || id)
    const summaryBlock = summary?.content?.trim()
      ? '### 事件摘要\n' + summary.content.trim()
      : '### 事件摘要\n（无）'
    const msgBlock = [
      '### 近条消息',
      ...recent.map((item) => '- ' + item.role + ': ' + clip(item.content, 400)),
    ].join('\n')
    let block = header + '\n' + summaryBlock + '\n' + msgBlock
    if (block.length > EXTRACT_SESSION_CHAR_BUDGET) {
      block = block.slice(0, EXTRACT_SESSION_CHAR_BUDGET) + '\n…（已截断）'
    }
    parts.push(block)
  }
  if (parts.length === 0) {
    throw new AppError(400, '所选会话不存在或没有可总结的内容。')
  }
  return ['请根据以下历史对话抽出一条可复用的通用技能（Markdown）。', '', ...parts].join('\n')
}

export function parseSkillDraftFromMarkdown(markdown: string): SkillDraftParsed {
  const text = markdown.trim()
  const name =
    matchField(text, /技能名称[:：]\s*(.+)\s*$/m) ||
    matchField(text, /^#+\s*(.+)\s*$/m) ||
    '未命名技能'
  const scenario =
    matchField(
      text,
      /适用场景[:：]\s*([\s\S]*?)(?=\n\s*(?:\d+\.|#{1,3}\s*|\*\*|步骤|输入与产出|注意边界|$))/m,
    ) ||
    matchField(text, /适用场景[:：]\s*(.+)/) ||
    ''
  const steps = extractSteps(text)
  const clippedName = name.replace(/[*`]/g, '').trim().slice(0, 20) || '未命名技能'
  return {
    name: clippedName,
    scenario: scenario.trim(),
    steps: steps.length > 0 ? steps : ['根据对话完善可执行步骤'],
    body: text,
  }
}

/** 开始抽技能：调模型 → 写助手气泡 → 挂 pending 草案（未确认不落 skills）。 */
export async function startSkillExtract(
  repos: Repos,
  input: StartSkillExtractInput,
): Promise<{ draft: SkillExtractDraft; messageId: string }> {
  const ids = [...new Set(input.sourceConversationIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) throw new AppError(400, '请至少选择一个会话再开始总结。')

  const friend = await repos.friends.get(input.friendId)
  if (!friend) throw new AppError(404, '找不到这个好友')
  const target = await repos.conversations.get(input.targetConversationId)
  if (!target) throw new AppError(404, '找不到当前会话')
  if (!(target.kind === 'direct' && target.friendIds[0] === friend.id)) {
    throw new AppError(400, '只能在该好友的单聊里抽技能，不能跨好友混选。')
  }
  for (const id of ids) {
    const source = await repos.conversations.get(id)
    if (!source || source.kind !== 'direct' || source.friendIds[0] !== friend.id) {
      throw new AppError(400, '只能选择当前好友下的会话。')
    }
  }

  const pending = await repos.skillExtractDrafts.listPendingByConversation(input.targetConversationId)
  if (pending.length > 0) {
    throw new AppError(409, '正在提炼中或已有待确认草案，请先处理后再试。')
  }

  const systemPrompt = normalizeSkillExtractPrompt(input.skillExtractPrompt)
  const userContent = await buildExtractUserContent(repos, ids)
  const chatFn = input.chatFn ?? defaultChatFn(repos)
  let markdown = ''
  try {
    markdown = (await chatFn({ friend, systemPrompt, userContent })).trim()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new AppError(502, '抽技能失败：' + message)
  }
  if (!markdown) throw new AppError(502, '模型没有返回技能草案，请稍后重试。')

  const parsed = parseSkillDraftFromMarkdown(markdown)
  const now = Date.now()
  const messageId = crypto.randomUUID()
  await repos.messages.put({
    id: messageId,
    conversationId: target.id,
    role: 'assistant',
    content: markdown,
    status: 'complete',
    speakerFriendId: friend.id,
    createdAt: now,
  })

  const draft: SkillExtractDraft = {
    id: crypto.randomUUID(),
    conversationId: target.id,
    friendId: friend.id,
    sourceConversationIds: ids,
    messageId,
    name: parsed.name,
    steps: parsed.steps,
    body: parsed.body,
    scenario: parsed.scenario,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  await repos.skillExtractDrafts.put(draft)
  await repos.conversations.put({ ...target, updatedAt: now })
  log('info', 'skill-extract', '已生成待确认草案', {
    id: draft.id,
    friendId: friend.id,
    sources: ids.length,
  })
  return { draft, messageId }
}

export async function listPendingSkillExtracts(
  repos: Repos,
  conversationId: string,
): Promise<SkillExtractDraft[]> {
  return repos.skillExtractDrafts.listPendingByConversation(conversationId)
}

export async function confirmSkillExtract(
  repos: Repos,
  draftId: string,
  options: { name?: string } = {},
): Promise<{ draft: SkillExtractDraft; skill: Skill }> {
  const draft = await repos.skillExtractDrafts.get(draftId)
  if (!draft) throw new AppError(404, '找不到这条抽技能草案')
  if (draft.status !== 'pending') throw new AppError(400, '这条草案已经处理过了')
  const name = (options.name ?? draft.name).trim() || draft.name
  const skill = await saveSkillForFriend(repos, {
    name,
    friendId: draft.friendId,
    steps: draft.steps.length > 0 ? draft.steps : [name],
  })
  if (draft.body.trim()) {
    await repos.skills.put({
      ...skill,
      body: draft.body.trim(),
      description: draft.scenario?.trim() || skill.description,
      updatedAt: Date.now(),
    })
  }
  const next: SkillExtractDraft = {
    ...draft,
    name,
    status: 'confirmed',
    skillId: skill.id,
    updatedAt: Date.now(),
  }
  await repos.skillExtractDrafts.put(next)
  log('info', 'skill-extract', '确认保存为好友技能', { id: draft.id, skillId: skill.id })
  return { draft: next, skill: (await repos.skills.get(skill.id))! }
}

export async function cancelSkillExtract(repos: Repos, draftId: string): Promise<SkillExtractDraft> {
  const draft = await repos.skillExtractDrafts.get(draftId)
  if (!draft) throw new AppError(404, '找不到这条抽技能草案')
  if (draft.status !== 'pending') throw new AppError(400, '这条草案已经处理过了')
  const next: SkillExtractDraft = { ...draft, status: 'cancelled', updatedAt: Date.now() }
  await repos.skillExtractDrafts.put(next)
  log('info', 'skill-extract', '取消抽技能草案', { id: draft.id })
  return next
}

function defaultChatFn(repos: Repos): SkillExtractChatFn {
  return async ({ friend, systemPrompt, userContent }) => {
    const providers = await repos.providers.list()
    const provider =
      providers.find((item) => item.id === friend.providerId && item.enabled) ??
      providers.find((item) => item.enabled)
    if (!provider) throw new Error('没有可用的模型提供方')
    const model = friend.defaultModelId || provider.defaultModel
    if (!model) throw new Error('好友还没有默认模型')
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]
    const result = await chat({
      baseUrl: provider.baseUrl,
      model,
      messages,
      temperature: 0.3,
    })
    return result.content
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

function matchField(text: string, re: RegExp): string {
  const match = re.exec(text)
  return match?.[1]?.trim() ?? ''
}

function extractSteps(text: string): string[] {
  const steps: string[] = []
  const block =
    /(?:步骤|Steps)[:：]?\s*([\s\S]*?)(?=\n\s*(?:输入与产出|注意边界|Out of scope|#{1,3}\s+|$))/i.exec(
      text,
    )
  const source = block?.[1] ?? text
  for (const line of source.split('\n')) {
    const ordered = /^\s*(?:\d+[\.\)、]|[-*•])\s+(.+)\s*$/.exec(line)
    if (ordered?.[1]) steps.push(ordered[1].replace(/[*`]/g, '').trim())
  }
  return steps.filter(Boolean).slice(0, 12)
}
