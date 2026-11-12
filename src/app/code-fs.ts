/**
 * p1.1 只读文件系统工具：list / read / grep。均受 Workspace 沙箱约束。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Friend } from '../domain/types.ts'
import { AppError } from './errors.ts'
import { assertCanRead, resolveInWorkspace } from './code-workspace.ts'

const MAX_READ_BYTES = 256 * 1024
const MAX_GREP_HITS = 50
const MAX_GREP_FILE_BYTES = 512 * 1024

export type ListEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory' | 'other'
}

export async function listWorkspace(
  friend: Friend,
  inputPath = '.',
): Promise<{ rootRelative: string; entries: ListEntry[] }> {
  const root = assertCanRead(friend)
  const resolved = resolveInWorkspace(root, inputPath)
  let info
  try {
    info = await stat(resolved.absolute)
  } catch {
    throw new AppError(404, `路径不存在：${resolved.relative}`)
  }
  if (!info.isDirectory()) {
    throw new AppError(400, `不是目录：${resolved.relative}`)
  }
  const names = await readdir(resolved.absolute)
  const entries: ListEntry[] = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const abs = path.join(resolved.absolute, name)
    const rel =
      resolved.relative === '.' ? name : `${resolved.relative}/${name}`.replace(/\\/g, '/')
    let kind: ListEntry['kind'] = 'other'
    try {
      const s = await stat(abs)
      kind = s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other'
    } catch {
      kind = 'other'
    }
    entries.push({ name, relativePath: rel, kind })
  }
  return { rootRelative: resolved.relative, entries }
}

export async function readWorkspaceFile(
  friend: Friend,
  inputPath: string,
): Promise<{ relativePath: string; content: string; truncated: boolean }> {
  const root = assertCanRead(friend)
  const resolved = resolveInWorkspace(root, inputPath)
  let info
  try {
    info = await stat(resolved.absolute)
  } catch {
    throw new AppError(404, `文件不存在：${resolved.relative}`)
  }
  if (!info.isFile()) throw new AppError(400, `不是文件：${resolved.relative}`)
  const buf = await readFile(resolved.absolute)
  const truncated = buf.byteLength > MAX_READ_BYTES
  const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf
  return {
    relativePath: resolved.relative,
    content: slice.toString('utf8'),
    truncated,
  }
}

export type GrepHit = { relativePath: string; line: number; text: string }

export async function grepWorkspace(
  friend: Friend,
  pattern: string,
  inputPath = '.',
  globFilter?: string,
): Promise<{ hits: GrepHit[]; scannedFiles: number; truncated: boolean }> {
  const root = assertCanRead(friend)
  const needle = pattern.trim()
  if (!needle) throw new AppError(400, '搜索内容不能为空。')
  let regex: RegExp
  try {
    regex = new RegExp(needle, 'i')
  } catch {
    regex = new RegExp(escapeRegExp(needle), 'i')
  }
  const start = resolveInWorkspace(root, inputPath)
  const hits: GrepHit[] = []
  let scannedFiles = 0
  let truncated = false

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (hits.length >= MAX_GREP_HITS) {
      truncated = true
      return
    }
    let names: string[]
    try {
      names = await readdir(absDir)
    } catch {
      return
    }
    for (const name of names) {
      if (hits.length >= MAX_GREP_HITS) {
        truncated = true
        return
      }
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'data') continue
      const abs = path.join(absDir, name)
      const rel = relDir === '.' ? name : `${relDir}/${name}`
      let s
      try {
        s = await stat(abs)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!s.isFile()) continue
      if (globFilter && !simpleGlobMatch(name, globFilter) && !simpleGlobMatch(rel, globFilter)) continue
      if (s.size > MAX_GREP_FILE_BYTES) continue
      scannedFiles += 1
      let text: string
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i]!)) {
          hits.push({ relativePath: rel.replace(/\\/g, '/'), line: i + 1, text: lines[i]!.slice(0, 240) })
          if (hits.length >= MAX_GREP_HITS) {
            truncated = true
            return
          }
        }
      }
    }
  }

  let startStat
  try {
    startStat = await stat(start.absolute)
  } catch {
    throw new AppError(404, `路径不存在：${start.relative}`)
  }
  if (startStat.isFile()) {
    scannedFiles = 1
    const text = await readFile(start.absolute, 'utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i]!)) {
        hits.push({
          relativePath: start.relative.replace(/\\/g, '/'),
          line: i + 1,
          text: lines[i]!.slice(0, 240),
        })
        if (hits.length >= MAX_GREP_HITS) {
          truncated = true
          break
        }
      }
    }
  } else {
    await walk(start.absolute, start.relative)
  }
  return { hits, scannedFiles, truncated }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 极简 glob：仅 * 通配，用于文件名或相对路径。 */
function simpleGlobMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}
