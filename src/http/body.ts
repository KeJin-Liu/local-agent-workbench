/**
 * 读取请求体。JSON 给设置和好友用，multipart 只取一个文件字段。
 */

import type { IncomingMessage } from 'node:http'
import { AppError } from '../app/errors.ts'

export type UploadedPart = {
  filename: string
  mediaType: string
  data: Buffer
}

/** 读完整段请求体，超过 limit 就拒绝。 */
export async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new AppError(413, '请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** 解析 JSON。空体当成 {}。 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req, 1_000_000)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw new AppError(400, '请求体不是 JSON')
  }
}

/**
 * 取出 multipart 里第一个带文件名的部分。
 * 头像与聊天附件共用；limit 默认 2.5MB，附件上传可提到 12MB。
 */
export async function readUploadedFile(req: IncomingMessage, limit = 2_500_000): Promise<UploadedPart> {
  const contentType = req.headers['content-type'] ?? ''
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim()
  if (!boundary) throw new AppError(400, '上传缺少 boundary')
  const body = await readRaw(req, limit)
  const marker = Buffer.from(`--${boundary}`)
  let cursor = body.indexOf(marker)
  if (cursor < 0) throw new AppError(400, '上传内容不完整')
  while (cursor >= 0) {
    cursor += marker.length
    if (body.subarray(cursor, cursor + 2).toString() === '--') break
    if (body.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) throw new AppError(400, '上传头不完整')
    const headerText = body.subarray(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (next < 0) throw new AppError(400, '上传正文不完整')
    const filename = filenameFrom(headerText)
    if (filename) {
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText)
      return {
        filename,
        mediaType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        data: body.subarray(dataStart, next),
      }
    }
    cursor = next + 2
  }
  throw new AppError(400, '没有收到文件')
}

function filenameFrom(headerText: string): string | null {
  const quoted = /filename="([^"]+)"/i.exec(headerText)
  if (quoted?.[1]) return quoted[1]
  const plain = /filename=([^;\r\n]+)/i.exec(headerText)
  return plain?.[1]?.trim() ?? null
}
