/**
 * 重复模式 → 建议沉淀技能。确认前不写 skills；忽略只改建议状态 / 静默。
 */

import type { SettingScope, Skill, SkillSuggestion } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { AppError } from './errors.ts'

const MIN_OCCURRENCES = 3
const MIN_PATTERN_LEN = 4
/** 与 UI「近 7 天」一致：只统计窗口内用户消息。 */
export const SUGGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 规范化用户话术，便于计次。 */
export function fingerprintPattern(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[。！？!?.,，、；;：:\s]+$/g, '')
    .replace(/\s+/g, ' ')
}

export function splitSteps(pattern: string): string[] {
  const parts = pattern
    .split(/[/／、,，;；|｜]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (parts.length >= 2) return parts
  return [pattern.trim()].filter(Boolean)
}

export function suggestName(pattern: string, steps: string[]): string {
  if (steps.length >= 2) return steps.slice(0, 3).join(' · ').slice(0, 24)
  return pattern.replace(/\s+/g, '').slice(0, 16) || '重复模式技能'
}

/**
 * 在当前会话近 7 天用户消息里找重复模式；达到阈值则挂一张 pending 建议卡。
 * 不写入 skills。
 */
export async function detectSkillSuggestion(
  repos: Repos,
  conversationId: string,
): Promise<SkillSuggestion | null> {
  const conversation = await repos.conversations.get(conversationId)
  if (!conversation) return null
  const friendId = conversation.friendIds[0]
  if (!friendId) return null

  const cutoff = Date.now() - SUGGEST_WINDOW_MS
  const messages = await repos.messages.listByConversation(conversationId)
  const counts = new Map<string, { text: string; count: number }>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.status === 'error') continue
    if (message.createdAt < cutoff) continue
    const raw = message.content.trim()
    if (raw.length < MIN_PATTERN_LEN) continue
    if (raw.startsWith('/')) continue
    const fingerprint = fingerprintPattern(raw)
    if (fingerprint.length < MIN_PATTERN_LEN) continue
    const current = counts.get(fingerprint)
    if (current) current.count += 1
    else counts.set(fingerprint, { text: raw, count: 1 })
  }

  const ranked = [...counts.entries()]
    .filter(([, value]) => value.count >= MIN_OCCURRENCES)
    .sort((a, b) => b[1].count - a[1].count || b[1].text.length - a[1].text.length)
  if (ranked.length === 0) return null

  const mutes = await repos.skillSuggestionMutes.list()
  const muted = new Set(
    mutes.filter((item) => item.friendId === friendId).map((item) => item.fingerprint),
  )
  const pending = await repos.skillSuggestions.list()
  const pendingFingerprints = new Set(
    pending
      .filter((item) => item.friendId === friendId && item.status === 'pending')
      .map((item) => item.fingerprint),
  )
  const attached = await repos.skills.list()
  const attachedNames = new Set(
    attached.filter((skill) => skill.friendIds?.includes(friendId)).map((skill) => skill.name),
  )

  for (const [fingerprint, value] of ranked) {
    if (muted.has(fingerprint)) continue
    if (pendingFingerprints.has(fingerprint)) {
      const existing = pending.find(
        (item) => item.friendId === friendId && item.status === 'pending' && item.fingerprint === fingerprint,
      )
      if (existing && existing.occurrenceCount !== value.count) {
        const updated: SkillSuggestion = {
          ...existing,
          occurrenceCount: value.count,
          updatedAt: Date.now(),
        }
        await repos.skillSuggestions.put(updated)
        return updated
      }
      return existing ?? null
    }
    const steps = splitSteps(value.text)
    const name = suggestName(value.text, steps)
    if (attachedNames.has(name)) continue
    const now = Date.now()
    const suggestion: SkillSuggestion = {
      id: crypto.randomUUID(),
      conversationId,
      friendId,
      pattern: value.text,
      occurrenceCount: value.count,
      name,
      steps,
      status: 'pending',
      fingerprint,
      createdAt: now,
      updatedAt: now,
    }
    await repos.skillSuggestions.put(suggestion)
    log('info', 'skill-suggest', '出示建议技能确认卡', {
      id: suggestion.id,
      conversationId,
      count: value.count,
    })
    return suggestion
  }
  return null
}

export async function listPendingSkillSuggestions(
  repos: Repos,
  conversationId: string,
): Promise<SkillSuggestion[]> {
  return repos.skillSuggestions.listPendingByConversation(conversationId)
}

/**
 * 人确认后才写入 skills，并挂到好友（或全局）。
 * pending 建议本身不是技能；确认失败则 skills 无新增。
 */
export async function acceptSkillSuggestion(
  repos: Repos,
  id: string,
  input: {
    name?: string
    scope: SettingScope
    friendIds?: string[]
    muteSimilar?: boolean
  },
): Promise<{ suggestion: SkillSuggestion; skill: Skill }> {
  const suggestion = await repos.skillSuggestions.get(id)
  if (!suggestion || suggestion.status !== 'pending') throw new AppError(400, '这张建议卡已经结束。')
  const scope = input.scope
  if (scope !== 'global' && scope !== 'friends') throw new AppError(400, '作用域不正确。')
  const name = (input.name ?? suggestion.name).trim()
  if (!name) throw new AppError(400, '技能名称不能为空。')
  const steps = suggestion.steps.map((step) => step.trim()).filter(Boolean)
  if (steps.length === 0) throw new AppError(400, '至少要有一个步骤。')

  let friendIds =
    scope === 'friends'
      ? [...new Set((input.friendIds?.length ? input.friendIds : [suggestion.friendId]).map((item) => item.trim()).filter(Boolean))]
      : []
  if (scope === 'friends' && friendIds.length === 0) throw new AppError(400, '指定好友时至少选一个。')
  if (scope === 'friends') {
    for (const friendId of friendIds) {
      if (!(await repos.friends.get(friendId))) throw new AppError(400, '指定的好友不存在，没有写入。')
    }
  }

  const now = Date.now()
  const skill: Skill = {
    id: crypto.randomUUID(),
    name,
    description: steps.join(' · '),
    body: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    steps,
    status: 'ready',
    scope,
    ...(scope === 'friends' ? { friendIds } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await repos.skills.put(skill)

  const next: SkillSuggestion = {
    ...suggestion,
    name,
    status: 'accepted',
    scope,
    ...(scope === 'friends' ? { friendIds } : {}),
    updatedAt: now,
  }
  await repos.skillSuggestions.put(next)

  if (input.muteSimilar) {
    await muteFingerprint(repos, suggestion.friendId, suggestion.fingerprint)
  }

  log('info', 'skill-suggest', '确认保存建议技能', { suggestionId: id, skillId: skill.id, scope })
  return { suggestion: next, skill }
}

/** 忽略：不写 skills。可选静默类似模式。 */
export async function dismissSkillSuggestion(
  repos: Repos,
  id: string,
  muteSimilar = false,
): Promise<void> {
  const suggestion = await repos.skillSuggestions.get(id)
  if (!suggestion) throw new AppError(404, '找不到这张建议卡')
  if (suggestion.status !== 'pending') {
    if (muteSimilar) await muteFingerprint(repos, suggestion.friendId, suggestion.fingerprint)
    return
  }
  await repos.skillSuggestions.put({
    ...suggestion,
    status: 'dismissed',
    updatedAt: Date.now(),
  })
  if (muteSimilar) await muteFingerprint(repos, suggestion.friendId, suggestion.fingerprint)
  log('info', 'skill-suggest', '忽略建议技能，未写库', { id, muteSimilar })
}

async function muteFingerprint(repos: Repos, friendId: string, fingerprint: string): Promise<void> {
  const existing = (await repos.skillSuggestionMutes.list()).find(
    (item) => item.friendId === friendId && item.fingerprint === fingerprint,
  )
  if (existing) return
  await repos.skillSuggestionMutes.put({
    id: crypto.randomUUID(),
    friendId,
    fingerprint,
    createdAt: Date.now(),
  })
}
