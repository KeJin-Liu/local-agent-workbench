/**
 * 聊天附件落盘。与头像分开：data/media，带旁路 meta 记住原名与 MIME。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logger.ts'
import { detectImage, extensionFor, type ImageKind } from './avatar-files.ts'

export type MediaKind = 'image' | 'file'

export type StoredMedia = {
  id: string
  kind: MediaKind
  name: string
  mime: string
  size: number
  path: string
  fileName: string
}

const MEDIA_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i

const SAFE_EXT = /^[a-z0-9]{1,8}$/i

export type MediaFiles = {
  mediaDir: string
  save: (input: {
    id: string
    kind: MediaKind
    name: string
    mime: string
    data: Buffer
    ext: string
  }) => Promise<StoredMedia>
  read: (fileName: string) => Promise<Buffer | undefined>
  readMeta: (id: string) => Promise<StoredMedia | undefined>
  resolve: (id: string) => Promise<StoredMedia | undefined>
}

/** @param mediaDir data/media */
export function createMediaFiles(mediaDir: string): MediaFiles {
  const root = path.resolve(mediaDir)

  return {
    mediaDir: root,
    async save(input) {
      await mkdir(root, { recursive: true })
      const ext = sanitizeExt(input.ext)
      const fileName = `${input.id}.${ext}`
      const filePath = path.join(root, fileName)
      if (path.resolve(filePath) !== filePath || !filePath.startsWith(root + path.sep)) {
        throw new Error('附件文件名不合法')
      }
      await writeFile(filePath, input.data)
      const stored: StoredMedia = {
        id: input.id,
        kind: input.kind,
        name: input.name,
        mime: input.mime,
        size: input.data.length,
        path: `/media/files/${fileName}`,
        fileName,
      }
      await writeFile(path.join(root, `${input.id}.json`), JSON.stringify(stored), 'utf8')
      log('info', 'media', '保存附件', { id: input.id, kind: input.kind, bytes: input.data.length })
      return stored
    },
    async read(fileName) {
      if (!MEDIA_NAME.test(fileName)) return undefined
      return readInside(root, fileName)
    },
    async readMeta(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
      const raw = await readInside(root, `${id}.json`)
      if (!raw) return undefined
      try {
        return JSON.parse(raw.toString('utf8')) as StoredMedia
      } catch {
        return undefined
      }
    },
    async resolve(id) {
      const meta = await this.readMeta(id)
      if (!meta) return undefined
      const body = await this.read(meta.fileName)
      if (!body) return undefined
      return meta
    },
  }
}

export function pickMediaExt(kind: MediaKind, imageKind: ImageKind | null, filename: string, mime: string): string {
  if (kind === 'image' && imageKind) return extensionFor(imageKind)
  const fromName = path.extname(filename).replace(/^\./, '').toLowerCase()
  if (SAFE_EXT.test(fromName) && fromName !== 'svg') return fromName
  if (mime.includes('pdf')) return 'pdf'
  if (mime.includes('json')) return 'json'
  if (mime.includes('markdown') || mime === 'text/markdown') return 'md'
  if (mime.startsWith('text/')) return 'txt'
  return 'bin'
}

export function classifyUpload(data: Buffer, mime: string, filename: string): {
  kind: MediaKind
  imageKind: ImageKind | null
  mime: string
} {
  const imageKind = detectImage(data)
  if (imageKind) {
    const mimeMap = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const
    return { kind: 'image', imageKind, mime: mimeMap[imageKind] }
  }
  const lower = filename.toLowerCase()
  if (lower.endsWith('.svg') || mime.includes('svg')) {
    throw new Error('SVG')
  }
  return { kind: 'file', imageKind: null, mime: mime || 'application/octet-stream' }
}

function sanitizeExt(ext: string): string {
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!SAFE_EXT.test(clean) || clean === 'svg') return 'bin'
  return clean
}

async function readInside(root: string, fileName: string): Promise<Buffer | undefined> {
  const resolved = path.resolve(root, fileName)
  if (resolved !== path.join(root, fileName)) return undefined
  try {
    return await readFile(resolved)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
    if (code === 'ENOENT') return undefined
    throw error
  }
}
