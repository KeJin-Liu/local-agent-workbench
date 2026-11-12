/**
 * 技能草稿列表。编辑器留到手工技能阶段。
 */

import type { Skill } from '../domain/types.ts'
import type { Repos } from '../storage/repos/index.ts'

/** @param repos 本地仓库 */
export async function listSkillDrafts(repos: Repos): Promise<Skill[]> {
  const skills = await repos.skills.list()
  return skills
    .filter((skill) => skill.status === 'draft')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh'))
}
