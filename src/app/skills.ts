/**
 * 手工把一段对话保存成技能，并挂到一个好友上。确认前不写库。
 */

import type { Skill } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import { AppError } from './errors.ts'

export type SaveSkillInput = {
  name: string
  steps: string[]
  friendId: string
}

/** 挂在这个好友上的技能。全局技能不出现在「已挂技能」里。 */
export async function listAttachedSkills(repos: Repos, friendId: string): Promise<Skill[]> {
  const skills = await repos.skills.list()
  return skills
    .filter((skill) => skill.friendIds?.includes(friendId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh'))
}

/** 确认后写入技能。步骤同时放进 steps 和 body，旧的纯文本读者仍能看。 */
export async function saveSkillForFriend(repos: Repos, input: SaveSkillInput): Promise<Skill> {
  const name = input.name.trim()
  if (!name) throw new AppError(400, '技能名称不能为空。')
  const steps = input.steps.map((step) => step.trim()).filter(Boolean)
  if (steps.length === 0) throw new AppError(400, '至少要有一个步骤。')
  const friend = await repos.friends.get(input.friendId)
  if (!friend) throw new AppError(400, '要挂上的好友不存在。')
  const now = Date.now()
  const skill: Skill = {
    id: crypto.randomUUID(),
    name,
    description: steps.join(' · '),
    body: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    steps,
    status: 'ready',
    scope: 'friends',
    friendIds: [friend.id],
    createdAt: now,
    updatedAt: now,
  }
  await repos.skills.put(skill)
  log('info', 'skills', '手工保存并挂到好友', { id: skill.id, friendId: friend.id })
  return skill
}

/** 从该好友的已挂列表拿掉。只挂了这一个好友时整条删除。 */
export async function detachSkill(repos: Repos, skillId: string, friendId: string): Promise<void> {
  const skill = await repos.skills.get(skillId)
  if (!skill) throw new AppError(404, '找不到这个技能')
  const rest = (skill.friendIds ?? []).filter((id) => id !== friendId)
  if (rest.length === 0) {
    await repos.skills.delete(skillId)
    log('info', 'skills', '移除已挂技能', { id: skillId, friendId })
    return
  }
  await repos.skills.put({ ...skill, friendIds: rest, updatedAt: Date.now() })
  log('info', 'skills', '从好友摘下技能', { id: skillId, friendId })
}
