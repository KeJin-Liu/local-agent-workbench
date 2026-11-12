/**
 * 会话占位。这一步只建列表记录，不发送消息。
 */

import path from 'node:path'
import type { Conversation, Friend, FriendAvatar, GroupMemberModel } from '../domain/types.ts'
import { ensureWorkspaceRoot, resolveMemberWorkspace } from './code-workspace.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { OLLAMA_PROVIDER_ID } from '../storage/schema.ts'
import { AppError } from './errors.ts'
import { previewMemoryInject } from '../memory/inject.ts'
import {
  getLtmInjectPref,
  listInjectableForConversation,
  listLongTermMemories,
  projectOwnerId,
} from './long-term-memory.ts'
import { listPendingSkillSuggestions } from './skill-suggestions.ts'
import { listPendingSkillExtracts } from './skill-extract.ts'

/** 最近更新的在前。 */
export async function listConversations(repos: Repos): Promise<Conversation[]> {
  const conversations = await repos.conversations.list()
  return conversations.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh'))
}

export type CreateConversationOptions = {
  kind?: Conversation['kind']
  friendIds?: string[]
  model?: string
  lineageId?: string
  /** 群头像；不传则用默认「群」字块。 */
  avatar?: FriendAvatar
  workspaceRoot?: string
  memberWorkspaces?: Record<string, string>
  memberPrompts?: Record<string, string>
  memberModels?: Record<string, GroupMemberModel>
}

/** 用当前的 Ollama 提供方和群主好友建一条单聊。传入好友 id 时按那些好友建单聊或群聊。 */
export async function createConversation(
  repos: Repos,
  title: string,
  options: CreateConversationOptions = {},
): Promise<Conversation> {
  const trimmed = title.trim()
  if (!trimmed) throw new AppError(400, '会话标题不能为空。')
  const providers = await repos.providers.list()
  const friends = await repos.friends.list()
  const requested = [...new Set(options.friendIds ?? [])].filter((id) => friends.some((friend) => friend.id === id))
  if (options.kind === 'group' && requested.length < 2) {
    throw new AppError(400, '群聊至少要两个好友。')
  }
  const owner = friends.find((friend) => friend.isOwnerTemplate) ?? friends[0]
  const friendIds = requested.length > 0 ? requested : owner ? [owner.id] : []
  const primary = friends.find((friend) => friend.id === friendIds[0]) ?? owner
  const bound = primary ? providers.find((item) => item.id === primary.providerId && item.enabled) : undefined
  const provider =
    bound ??
    providers.find((item) => item.id === OLLAMA_PROVIDER_ID && item.enabled) ??
    providers.find((item) => item.enabled)
  if (!provider) throw new AppError(400, '没有可用的提供方。先在模型设置里启用一个。')
  const model = options.model?.trim() || primary?.defaultModelId || provider.defaultModel
  const now = Date.now()
  const id = crypto.randomUUID()
  const kind = options.kind === 'group' || friendIds.length > 1 ? 'group' : 'direct'
  const lineageId = options.lineageId || (kind === 'direct' && friendIds.length === 1 ? `friend:${friendIds[0]}` : id)
  const workspaceRoot = kind === 'group' ? cleanWorkspaceRoot(options.workspaceRoot) : undefined
  const memberWorkspaces =
    kind === 'group' ? cleanMemberWorkspaces(options.memberWorkspaces, friendIds) : undefined
  const memberPrompts = kind === 'group' ? cleanMemberPrompts(options.memberPrompts, friendIds) : undefined
  const memberModels = kind === 'group' ? cleanMemberModels(options.memberModels, friendIds) : undefined
  const conversation: Conversation = {
    id,
    title: trimmed,
    kind,
    friendIds,
    providerId: primary?.providerId || provider.id,
    lineageId,
    createdAt: now,
    updatedAt: now,
    ...(model ? { model } : {}),
    ...(options.avatar ? { avatar: options.avatar } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(memberWorkspaces ? { memberWorkspaces } : {}),
    ...(memberPrompts ? { memberPrompts } : {}),
    ...(memberModels ? { memberModels } : {}),
  }
  await repos.conversations.put(conversation)
  if (kind === 'group') await ensureGroupMemberDirs(conversation, friends)
  log('info', 'app', '新建会话', { conversationId: conversation.id })
  return conversation
}

/** 改已有群的名称、成员和默认模型。单聊不走这里。 */
export async function updateGroupConversation(
  repos: Repos,
  id: string,
  options: {
    title: string
    friendIds: string[]
    model?: string
    avatar?: FriendAvatar | null
    /** 不传则保留原值；空字符串或 null 表示清掉。 */
    workspaceRoot?: string | null
    memberWorkspaces?: Record<string, string> | null
    /** 不传则保留；null 表示清掉。空字符串的条目会丢掉。 */
    memberPrompts?: Record<string, string> | null
    /** 不传则保留；null 表示清掉。缺提供方或模型的条目会丢掉。 */
    memberModels?: Record<string, GroupMemberModel> | null
  },
): Promise<Conversation> {
  const current = await repos.conversations.get(id)
  if (!current) throw new AppError(404, '找不到这个会话')
  if (current.kind !== 'group') throw new AppError(400, '只有群聊可以从这里改。')
  const trimmed = options.title.trim()
  if (!trimmed) throw new AppError(400, '群名称不能为空。')
  const friends = await repos.friends.list()
  const friendIds = [...new Set(options.friendIds)].filter((friendId) => friends.some((friend) => friend.id === friendId))
  if (friendIds.length < 2) throw new AppError(400, '群聊至少要两个好友。')
  const next: Conversation = {
    ...current,
    title: trimmed,
    friendIds,
    updatedAt: Date.now(),
  }
  if (options.model !== undefined) {
    const model = options.model.trim()
    if (model) next.model = model
    else delete next.model
  }
  if (options.avatar === null) delete next.avatar
  else if (options.avatar) next.avatar = options.avatar
  if (options.workspaceRoot !== undefined) {
    const root = cleanWorkspaceRoot(options.workspaceRoot)
    if (root) next.workspaceRoot = root
    else delete next.workspaceRoot
  }
  if (options.memberWorkspaces !== undefined) {
    const overrides = cleanMemberWorkspaces(options.memberWorkspaces, friendIds)
    if (overrides) next.memberWorkspaces = overrides
    else delete next.memberWorkspaces
  }
  if (options.memberPrompts !== undefined) {
    const prompts = cleanMemberPrompts(options.memberPrompts, friendIds)
    if (prompts) next.memberPrompts = prompts
    else delete next.memberPrompts
  }
  if (options.memberModels !== undefined) {
    const models = cleanMemberModels(options.memberModels, friendIds)
    if (models) next.memberModels = models
    else delete next.memberModels
  }
  await repos.conversations.put(next)
  await ensureGroupMemberDirs(next, friends)
  log('info', 'app', '更新群设置', { conversationId: id, friends: friendIds.length })
  return next
}

/**
 * 归档或取消归档整个群。同一 lineage 的每一段一起改，
 * 避免新开一段后又出现在「全部 / 群组」。
 */
export async function setGroupArchived(repos: Repos, id: string, archived: boolean): Promise<Conversation> {
  const current = await repos.conversations.get(id)
  if (!current) throw new AppError(404, '找不到这个会话')
  if (current.kind !== 'group') throw new AppError(400, '只有群聊可以归档。')
  const lineage = current.lineageId || current.id
  const related = (await repos.conversations.list()).filter(
    (item) => item.kind === 'group' && (item.lineageId || item.id) === lineage,
  )
  let updated = current
  for (const item of related) {
    const next: Conversation = { ...item }
    if (archived) next.archived = true
    else delete next.archived
    await repos.conversations.put(next)
    if (next.id === current.id) updated = next
  }
  log('info', 'app', archived ? '归档群聊' : '取消归档群聊', { conversationId: id, lineageId: lineage })
  return updated
}

/**
 * 给当前好友或群另起一段空白对话。列表仍只显示这一行。
 * 旧消息留在原来的会话里，不再出现在通讯录上。
 */
export async function startFreshThread(repos: Repos, conversationId: string): Promise<Conversation> {
  const current = await repos.conversations.get(conversationId)
  if (!current) throw new AppError(404, '找不到这个会话')
  const lineageId =
    current.lineageId ||
    (current.kind === 'direct' && current.friendIds.length === 1 ? `friend:${current.friendIds[0]}` : current.id)
  if (current.lineageId !== lineageId) {
    await repos.conversations.put({ ...current, lineageId })
  }
  const now = Date.now()
  const next: Conversation = {
    id: crypto.randomUUID(),
    title: current.title,
    kind: current.kind,
    friendIds: [...current.friendIds],
    providerId: current.providerId,
    lineageId,
    createdAt: now,
    updatedAt: now,
    ...(current.model ? { model: current.model } : {}),
    ...(current.avatar ? { avatar: current.avatar } : {}),
    ...(current.chatMode ? { chatMode: current.chatMode } : {}),
    ...(current.reasoningLevel ? { reasoningLevel: current.reasoningLevel } : {}),
    ...(current.workspaceRoot ? { workspaceRoot: current.workspaceRoot } : {}),
    ...(current.memberWorkspaces ? { memberWorkspaces: { ...current.memberWorkspaces } } : {}),
    ...(current.memberPrompts ? { memberPrompts: { ...current.memberPrompts } } : {}),
    ...(current.memberModels ? { memberModels: { ...current.memberModels } } : {}),
    ...(current.archived ? { archived: true } : {}),
  }
  await repos.conversations.put(next)
  log('info', 'app', '另起一段对话', { from: conversationId, conversationId: next.id, lineageId })
  return next
}

/** 会话正文：消息和 run，给发送中的轮询用。顺带带回长期记忆与建议技能。 */
export async function loadThread(repos: Repos, id: string) {
  const conversation = await repos.conversations.get(id)
  if (!conversation) throw new AppError(404, '找不到这个会话')
  const friendId = conversation.friendIds[0] ?? ''
  const projectId = conversation.kind === 'group' ? projectOwnerId(conversation) : ''
  const [messages, runs, assignments, summary, injectable, friendMemories, projectMemories, friendPref, projectPref, skillSuggestions, skillExtractDrafts, memoryInject] =
    await Promise.all([
      repos.messages.listByConversation(id),
      repos.runs.listByConversation(id),
      repos.assignments.listByConversation(id),
      repos.summaries.latest(id),
      listInjectableForConversation(repos, conversation),
      friendId ? listLongTermMemories(repos, 'friend', friendId) : Promise.resolve([]),
      projectId ? listLongTermMemories(repos, 'project', projectId) : Promise.resolve([]),
      friendId ? getLtmInjectPref(repos, 'friend', friendId) : Promise.resolve(null),
      projectId ? getLtmInjectPref(repos, 'project', projectId) : Promise.resolve(null),
      listPendingSkillSuggestions(repos, id),
      listPendingSkillExtracts(repos, id),
      previewMemoryInject(repos, id),
    ])
  return {
    conversation,
    messages,
    runs,
    assignments,
    summary: summary ?? null,
    memoryInject,
    longTermMemories: {
      friend: friendMemories,
      project: projectMemories,
      injectable: injectable.memories,
      friendInjectEnabled: friendPref?.injectEnabled ?? true,
      projectInjectEnabled: projectPref?.injectEnabled ?? true,
      friendOwnerId: friendId || null,
      projectOwnerId: projectId || null,
      friendCount: injectable.friendCount,
      projectCount: injectable.projectCount,
    },
    skillSuggestions,
    skillExtractDrafts,
  }
}

function cleanWorkspaceRoot(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return undefined
  return path.resolve(trimmed)
}

function cleanMemberModels(
  raw: Record<string, GroupMemberModel> | null | undefined,
  friendIds: string[],
): Record<string, GroupMemberModel> | undefined {
  if (!raw) return undefined
  const allowed = new Set(friendIds)
  const next: Record<string, GroupMemberModel> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id) || !value || typeof value !== 'object') continue
    const providerId = value.providerId?.trim() ?? ''
    const model = value.model?.trim() ?? ''
    if (!providerId || !model) continue
    next[id] = { providerId, model }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function cleanMemberPrompts(
  raw: Record<string, string> | null | undefined,
  friendIds: string[],
): Record<string, string> | undefined {
  if (!raw) return undefined
  const allowed = new Set(friendIds)
  const next: Record<string, string> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id) || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    next[id] = trimmed
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function cleanMemberWorkspaces(
  raw: Record<string, string> | null | undefined,
  friendIds: string[],
): Record<string, string> | undefined {
  if (!raw) return undefined
  const allowed = new Set(friendIds)
  const next: Record<string, string> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id) || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    next[id] = path.resolve(trimmed)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** 群根目录或手动目录生效时，把每个成员的目录建出来。 */
async function ensureGroupMemberDirs(conversation: Conversation, friends: Friend[]): Promise<void> {
  if (conversation.kind !== 'group') return
  for (const id of conversation.friendIds) {
    const friend = friends.find((item) => item.id === id)
    if (!friend) continue
    const resolved = resolveMemberWorkspace(conversation, friend)
    if (!resolved.autoFileOps || !resolved.root) continue
    await ensureWorkspaceRoot(resolved.root)
  }
}

/** 连同消息、run、摘要和指派一起删除。 */
export async function deleteConversation(repos: Repos, id: string): Promise<void> {
  await repos.conversations.deleteCascade(id)
  log('info', 'app', '删除会话', { conversationId: id })
}
