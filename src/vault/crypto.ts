/**
 * 保险库落盘加密。密钥文件在 data/vault.key，权限 0600。
 * 这只挡住随便打开 JSON 的人；拿到密钥文件的人仍然能解密。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logger.ts'

/** 读或创建 32 字节主密钥，并尽量把目录和文件收成仅当前用户可读。 */
export async function loadVaultKey(keyFile: string): Promise<Buffer> {
  const directory = path.dirname(keyFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => undefined)
  try {
    const existing = await readFile(keyFile)
    if (existing.length !== 32) throw new Error('vault.key 长度不对')
    await chmod(keyFile, 0o600).catch(() => undefined)
    return existing
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
    if (code !== 'ENOENT') throw error
  }
  const key = randomBytes(32)
  const handle = await open(keyFile, 'wx', 0o600)
  try {
    await handle.writeFile(key)
  } finally {
    await handle.close()
  }
  await chmod(keyFile, 0o600).catch(() => undefined)
  log('info', 'vault', '已创建保险库主密钥', { keyFile })
  return key
}

/** AES-256-GCM。返回值是 base64，不包含明文。 */
export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/** 解出 JSON。认证失败时抛错，不返回半截内容。 */
export function decryptJson<T>(key: Buffer, payload: string): T {
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length < 12 + 16) throw new Error('密文太短')
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const encrypted = buffer.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  return JSON.parse(plaintext) as T
}
