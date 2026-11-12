/**
 * 头像文件。内置 SVG 放在仓库里；用户上传只进 data/avatars，并且不能是 SVG。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logger.ts'

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif'

const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/i

/**
 * 认文件头，不信扩展名。上传的 SVG 直接拒绝，避免同源页面把脚本当图片打开。
 */
export function detectImage(data: Buffer): ImageKind | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 6 && data.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

export function extensionFor(kind: ImageKind): string {
  return kind === 'jpeg' ? 'jpg' : kind
}

export type AvatarFiles = {
  defaultsDir: string
  uploadDir: string
  defaultFile: (id: string) => string
  hasDefault: (id: string) => Promise<boolean>
  readDefault: (id: string) => Promise<Buffer | undefined>
  saveUpload: (id: string, kind: ImageKind, data: Buffer) => Promise<string>
  readUpload: (fileName: string) => Promise<Buffer | undefined>
}

/**
 * @param defaultsDir 仓库内置 SVG 目录
 * @param uploadDir data/avatars
 */
export function createAvatarFiles(defaultsDir: string, uploadDir: string): AvatarFiles {
  const defaultsRoot = path.resolve(defaultsDir)
  const uploadRoot = path.resolve(uploadDir)

  return {
    defaultsDir: defaultsRoot,
    uploadDir: uploadRoot,
    defaultFile(id) {
      return path.join(defaultsRoot, `${id}.svg`)
    },
    async hasDefault(id) {
      if (!/^[a-z0-9-]+$/.test(id)) return false
      try {
        await access(path.join(defaultsRoot, `${id}.svg`))
        return true
      } catch {
        return false
      }
    },
    async readDefault(id) {
      if (!/^[a-z0-9-]+$/.test(id)) return undefined
      return readInside(defaultsRoot, `${id}.svg`)
    },
    async saveUpload(id, kind, data) {
      await mkdir(uploadRoot, { recursive: true })
      const fileName = `${id}.${extensionFor(kind)}`
      const filePath = path.join(uploadRoot, fileName)
      // 再确认一次，防止 id 里夹了路径分隔符。
      if (path.resolve(filePath) !== filePath || !filePath.startsWith(uploadRoot + path.sep)) {
        throw new Error('头像文件名不合法')
      }
      await writeFile(filePath, data)
      log('info', 'avatars', '保存上传头像', { id, kind, bytes: data.length })
      return fileName
    },
    async readUpload(fileName) {
      if (!UPLOAD_NAME.test(fileName)) return undefined
      return readInside(uploadRoot, fileName)
    },
  }
}

/**
 * 只读根目录里面的那一个文件名。realpath 后仍必须留在根里。
 */
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
