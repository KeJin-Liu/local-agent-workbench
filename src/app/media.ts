/**
 * 聊天附件用例：multipart 上传、按 id 解析、静态读取。
 */

import { AppError } from './errors.ts'
import { log } from '../logger.ts'
import type { MessageAttachment } from '../domain/types.ts'
import {
  classifyUpload,
  createMediaFiles,
  pickMediaExt,
  type MediaFiles,
  type StoredMedia,
} from '../storage/media-files.ts'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 8

export type MediaService = {
  files: MediaFiles
  upload: (file: { filename: string; mediaType: string; data: Buffer }) => Promise<MessageAttachment>
  resolveMany: (ids: string[]) => Promise<MessageAttachment[]>
}

export function createMediaService(files: MediaFiles): MediaService {
  return {
    files,
    async upload(file) {
      if (file.data.length === 0) throw new AppError(400, '没有收到文件')
      if (file.data.length > MAX_UPLOAD_BYTES) throw new AppError(413, '附件不能超过 10MB')
      let classified: ReturnType<typeof classifyUpload>
      try {
        classified = classifyUpload(file.data, file.mediaType, file.filename)
      } catch {
        throw new AppError(400, '不支持 SVG，请换 PNG / JPEG / WEBP / GIF 或普通文件')
      }
      const id = crypto.randomUUID()
      const name = sanitizeName(file.filename)
      const ext = pickMediaExt(classified.kind, classified.imageKind, name, classified.mime)
      const stored = await files.save({
        id,
        kind: classified.kind,
        name,
        mime: classified.mime,
        data: file.data,
        ext,
      })
      log('info', 'media', '上传完成', { id, kind: stored.kind, bytes: stored.size })
      return toAttachment(stored)
    },
    async resolveMany(ids) {
      if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new AppError(400, `一次最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`)
      }
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
      const out: MessageAttachment[] = []
      for (const id of unique) {
        const stored = await files.resolve(id)
        if (!stored) throw new AppError(400, `找不到附件 ${id}`)
        out.push(toAttachment(stored))
      }
      return out
    },
  }
}

export function createMediaServiceAt(mediaDir: string): MediaService {
  return createMediaService(createMediaFiles(mediaDir))
}

function toAttachment(stored: StoredMedia): MessageAttachment {
  return {
    id: stored.id,
    kind: stored.kind,
    name: stored.name,
    mime: stored.mime,
    size: stored.size,
    path: stored.path,
  }
}

function sanitizeName(value: string): string {
  const base = value.split(/[/\\]/).pop()?.trim() || 'file'
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 120)
  return cleaned || 'file'
}

export { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES }
