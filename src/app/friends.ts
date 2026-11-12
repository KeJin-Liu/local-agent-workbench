/**
 * 好友用例。保存时把头像收成服务端认可的 id 和 path。
 */

import type { CodePermission, Friend, FriendAvatar, FriendVision } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { Repos } from '../storage/repos/index.ts'
import type { AvatarService } from './avatars.ts'
import { AppError } from './errors.ts'

export type FriendDraft = {
  id?: string
  name: string
  description?: string
  systemPrompt?: string
  avatar: FriendAvatar
  providerId?: string
  defaultModelId?: string
  /** p1.1：本机 Workspace；传空字符串可清除绑定。 */
  workspacePath?: string
  /** 传 null 清除档位（回默认语义）。 */
  codePermission?: CodePermission | null
  /** 传 null 清除视觉插件；不传保留原配置。 */
  vision?: FriendVision | null
}

/** 群主模板排在前面。 */
export async function listFriends(repos: Repos): Promise<Friend[]> {
  const friends = await repos.friends.list()
  return friends.sort((a, b) => {
    if (a.isOwnerTemplate !== b.isOwnerTemplate) return a.isOwnerTemplate ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })
}

/**
 * 新建或更新好友。isOwnerTemplate 只在已有记录上保留，不能靠请求体把自己标成群主模板。
 */
export async function upsertFriend(repos: Repos, avatars: AvatarService, draft: FriendDraft): Promise<Friend> {
  const name = draft.name.trim()
  if (!name) throw new AppError(400, '好友名称不能为空。')
  const avatar = await avatars.resolveAvatar(draft.avatar)
  const now = Date.now()
  const existing = draft.id ? await repos.friends.get(draft.id) : undefined
  const providerId = (draft.providerId ?? existing?.providerId ?? '').trim()
  if (!providerId) throw new AppError(400, '好友要绑定一个提供方。')
  const provider = await repos.providers.get(providerId)
  if (!provider) throw new AppError(400, '好友绑定的提供方不存在。')
  const defaultModelId = (
    draft.defaultModelId !== undefined
      ? draft.defaultModelId
      : existing?.defaultModelId ?? ''
  ).trim()
  const workspacePath =
    draft.workspacePath !== undefined
      ? draft.workspacePath.trim()
      : (existing?.workspacePath ?? '').trim()
  let codePermission: CodePermission | undefined
  if (draft.codePermission === null) {
    codePermission = undefined
  } else if (draft.codePermission !== undefined) {
    codePermission = draft.codePermission
  } else {
    codePermission = existing?.codePermission
  }
  if (
    codePermission &&
    codePermission !== 'read-only' &&
    codePermission !== 'workspace-write' &&
    codePermission !== 'danger-full-access'
  ) {
    throw new AppError(400, '编码权限不正确。')
  }
  let vision: FriendVision | undefined
  if (draft.vision === null) {
    vision = undefined
  } else if (draft.vision !== undefined) {
    const visionProviderId = (draft.vision.providerId ?? providerId).trim()
    if (!(await repos.providers.get(visionProviderId))) {
      throw new AppError(400, '视觉插件的提供方不存在。')
    }
    vision = {
      enabled: Boolean(draft.vision.enabled),
      providerId: visionProviderId,
      ...(draft.vision.modelId?.trim() ? { modelId: draft.vision.modelId.trim() } : {}),
    }
  } else {
    vision = existing?.vision
  }
  const friend: Friend = {
    id: existing?.id ?? draft.id ?? crypto.randomUUID(),
    name,
    description: (draft.description ?? '').trim(),
    systemPrompt: (draft.systemPrompt ?? '').trim(),
    isOwnerTemplate: existing?.isOwnerTemplate ?? false,
    avatar,
    providerId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(codePermission ? { codePermission } : {}),
    ...(vision ? { vision } : {}),
  }
  await repos.friends.put(friend)
  log('info', 'app', existing ? '更新好友' : '新建好友', {
    id: friend.id,
    avatarKind: avatar.kind,
    avatarId: avatar.id,
    providerId,
    defaultModelId: defaultModelId || undefined,
  })
  return friend
}
