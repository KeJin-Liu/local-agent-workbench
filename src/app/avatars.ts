/**
 * 头像用例：列出内置图，接受上传，并把好友上的 avatar 收成服务端认可的形状。
 * 不信任客户端传来的 path，避免指到 data 目录外面。
 */

import { randomUUID } from 'node:crypto'
import type { FriendAvatar } from '../domain/types.ts'
import { log } from '../logger.ts'
import { detectImage, type AvatarFiles } from '../storage/avatar-files.ts'
import { DEFAULT_AVATAR_CATALOG } from './avatar-catalog.ts'
import { AppError } from './errors.ts'

export type DefaultAvatar = FriendAvatar & {
  kind: 'default'
  id: string
  path: string
  label: string
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

export type AvatarService = {
  listDefaultAvatars: () => Promise<DefaultAvatar[]>
  uploadAvatar: (file: { filename: string; data: Buffer }) => Promise<FriendAvatar>
  resolveAvatar: (input: FriendAvatar | undefined) => Promise<FriendAvatar>
}

/** @param files 内置目录和上传目录 */
export function createAvatarService(files: AvatarFiles): AvatarService {
  return {
    async listDefaultAvatars() {
      const avatars: DefaultAvatar[] = []
      for (const item of DEFAULT_AVATAR_CATALOG) {
        const exists = await files.hasDefault(item.id)
        if (!exists) {
          log('warn', 'avatars', '默认头像文件缺失', { id: item.id })
          continue
        }
        avatars.push({
          kind: 'default',
          id: item.id,
          label: item.label,
          path: `/avatars/defaults/${item.id}.svg`,
        })
      }
      return avatars
    },

    async uploadAvatar(file) {
      if (file.data.length === 0) throw new AppError(400, '没有收到图片')
      if (file.data.length > MAX_UPLOAD_BYTES) throw new AppError(413, '图片不能超过 2MB')
      const kind = detectImage(file.data)
      if (!kind) {
        throw new AppError(400, '只接受 PNG、JPEG、WEBP 或 GIF。SVG 请改用内置头像。')
      }
      const id = randomUUID()
      const fileName = await files.saveUpload(id, kind, file.data)
      const avatar: FriendAvatar = { kind: 'upload', id, path: `/avatars/files/${fileName}` }
      log('info', 'avatars', '上传完成', { id, kind })
      return avatar
    },

    async resolveAvatar(input) {
      if (!input || (input.kind !== 'default' && input.kind !== 'upload')) {
        throw new AppError(400, '头像缺少 kind')
      }
      if (input.kind === 'default') {
        const id = input.id ?? ''
        const known = DEFAULT_AVATAR_CATALOG.find((item) => item.id === id)
        if (!known || !(await files.hasDefault(id))) throw new AppError(400, '没有这个默认头像')
        return { kind: 'default', id, path: `/avatars/defaults/${id}.svg` }
      }
      const id = input.id ?? ''
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(400, '上传头像的 id 不正确')
      // path 只用来取出我们自己签发的文件名，再核对 id，防止客户端换一个别的路径。
      const fileName = fileNameFromPath(input.path)
      if (!fileName || !fileName.startsWith(id)) throw new AppError(400, '上传头像不存在')
      const stored = await files.readUpload(fileName)
      if (!stored) throw new AppError(400, '上传头像不存在')
      return { kind: 'upload', id, path: `/avatars/files/${fileName}` }
    },
  }
}

function fileNameFromPath(value: string | undefined): string | null {
  if (!value) return null
  const name = value.split('/').pop() ?? ''
  if (!name || name.includes('..')) return null
  return name
}
