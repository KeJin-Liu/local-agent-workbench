/**
 * p1.1 写文件 / shell 门闩。stage 只存草稿；confirm 才 writeFile / spawn；cancel 丢弃。
 */

import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CodeAction, CodeToolTimelineEntry, Friend } from '../domain/types.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import { log } from '../logger.ts'
import { AppError } from './errors.ts'
import { assertCanWriteOrShell, assertShellStaysInWorkspace, resolveInWorkspace } from './code-workspace.ts'

export type StageWriteInput = {
  conversationId: string
  friend: Friend
  relativePath: string
  content: string
  runId?: string
  unifiedDiff?: string
}

export type StageDeleteInput = {
  conversationId: string
  friend: Friend
  relativePath: string
  runId?: string
}

export type StageShellInput = {
  conversationId: string
  friend: Friend
  command: string
  runId?: string
  timeoutMs?: number
}

const DEFAULT_SHELL_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 32_000

export function createCodeActionService(database: WorkbenchDatabase) {
  return {
    async listPending(conversationId: string): Promise<CodeAction[]> {
      return (await database.read()).stores.codeActions.filter(
        (item) => item.conversationId === conversationId && item.status === 'pending',
      )
    },

    async listTimeline(conversationId: string): Promise<CodeToolTimelineEntry[]> {
      return (await database.read()).stores.codeToolEvents
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    async recordTimeline(entry: Omit<CodeToolTimelineEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<CodeToolTimelineEntry> {
      const row: CodeToolTimelineEntry = {
        id: entry.id ?? crypto.randomUUID(),
        conversationId: entry.conversationId,
        friendId: entry.friendId,
        toolName: entry.toolName,
        detail: entry.detail,
        outcome: entry.outcome,
        createdAt: entry.createdAt ?? Date.now(),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.resultSummary ? { resultSummary: entry.resultSummary } : {}),
      }
      await database.update((document) => {
        document.stores.codeToolEvents.push(row)
      })
      return row
    },

    async stageWrite(input: StageWriteInput): Promise<CodeAction> {
      const root = assertCanWriteOrShell(input.friend)
      const resolved = resolveInWorkspace(root, input.relativePath)
      const content = input.content
      if (typeof content !== 'string') throw new AppError(400, '写入内容必须是文本。')
      let unifiedDiff = input.unifiedDiff?.trim()
      if (!unifiedDiff) {
        let previous = ''
        try {
          previous = await readFile(resolved.absolute, 'utf8')
        } catch {
          previous = ''
        }
        unifiedDiff = buildSimpleDiff(resolved.relative, previous, content)
      }
      const now = Date.now()
      const action: CodeAction = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        friendId: input.friend.id,
        kind: 'write',
        summary: `写入 ${resolved.relative}`,
        status: 'pending',
        draft: {
          relativePath: resolved.relative,
          absolutePath: resolved.absolute,
          content,
          unifiedDiff,
          workspacePath: root,
        },
        createdAt: now,
        updatedAt: now,
        ...(input.runId ? { runId: input.runId } : {}),
      }
      await database.update((document) => {
        document.stores.codeActions.push(action)
      })
      await this.recordTimeline({
        conversationId: input.conversationId,
        friendId: input.friend.id,
        runId: input.runId,
        toolName: 'workbench_fs_write',
        detail: resolved.relative,
        outcome: 'pending',
        resultSummary: '等待确认写入',
      })
      log('info', 'code', '出示写文件确认卡', { id: action.id, path: resolved.relative })
      return action
    },

    async stageDelete(input: StageDeleteInput): Promise<CodeAction> {
      const root = assertCanWriteOrShell(input.friend)
      const resolved = resolveInWorkspace(root, input.relativePath)
      if (resolved.relative === '.') throw new AppError(400, '不能删除工作目录本身。')
      await assertDeletable(resolved.absolute)
      const now = Date.now()
      const action: CodeAction = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        friendId: input.friend.id,
        kind: 'delete',
        summary: `删除 ${resolved.relative}`,
        status: 'pending',
        draft: {
          relativePath: resolved.relative,
          absolutePath: resolved.absolute,
          workspacePath: root,
        },
        createdAt: now,
        updatedAt: now,
        ...(input.runId ? { runId: input.runId } : {}),
      }
      await database.update((document) => {
        document.stores.codeActions.push(action)
      })
      await this.recordTimeline({
        conversationId: input.conversationId,
        friendId: input.friend.id,
        runId: input.runId,
        toolName: 'workbench_fs_delete',
        detail: resolved.relative,
        outcome: 'pending',
        resultSummary: '等待确认删除',
      })
      log('info', 'code', '出示删除确认卡', { id: action.id, path: resolved.relative })
      return action
    },

    async stageShell(input: StageShellInput): Promise<CodeAction> {
      const root = assertCanWriteOrShell(input.friend)
      const command = input.command.trim()
      if (!command) throw new AppError(400, '命令不能为空。')
      assertShellStaysInWorkspace(command, root)
      const timeoutMs =
        typeof input.timeoutMs === 'number' && input.timeoutMs > 0
          ? Math.min(input.timeoutMs, 5 * 60_000)
          : DEFAULT_SHELL_TIMEOUT_MS
      const now = Date.now()
      const action: CodeAction = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        friendId: input.friend.id,
        kind: 'shell',
        summary: command.length > 80 ? `${command.slice(0, 77)}…` : command,
        status: 'pending',
        draft: {
          command,
          cwd: root,
          timeoutMs,
        },
        createdAt: now,
        updatedAt: now,
        ...(input.runId ? { runId: input.runId } : {}),
      }
      await database.update((document) => {
        document.stores.codeActions.push(action)
      })
      await this.recordTimeline({
        conversationId: input.conversationId,
        friendId: input.friend.id,
        runId: input.runId,
        toolName: 'workbench_shell',
        detail: command,
        outcome: 'pending',
        resultSummary: '等待批准执行',
      })
      log('info', 'code', '出示命令确认卡', { id: action.id, command })
      return action
    },

    async confirm(id: string): Promise<CodeAction> {
      const before = (await database.read()).stores.codeActions.find((item) => item.id === id)
      if (!before || before.status !== 'pending') throw new AppError(400, '这张编码确认卡已经结束。')
      try {
        if (before.kind === 'write') {
          return await confirmWrite(database, before)
        }
        if (before.kind === 'delete') {
          return await confirmDelete(database, before)
        }
        return await confirmShell(database, before)
      } catch (error) {
        const message = error instanceof Error ? error.message : '确认失败'
        await database.update((document) => {
          const row = document.stores.codeActions.find((item) => item.id === id)
          if (row && row.status === 'pending') {
            row.status = 'failed'
            row.error = message
            row.updatedAt = Date.now()
          }
        })
        log('warn', 'code', '确认失败，未落盘/未执行', { id, error: message })
        throw error instanceof AppError ? error : new AppError(400, message)
      }
    },

    async cancel(id: string): Promise<void> {
      let cancelled: CodeAction | undefined
      await database.update((document) => {
        const row = document.stores.codeActions.find((item) => item.id === id)
        if (!row || row.status !== 'pending') throw new AppError(400, '这张编码确认卡已经结束。')
        row.status = 'cancelled'
        row.updatedAt = Date.now()
        cancelled = { ...row }
        // 与 proposals 一致：取消可移出 pending 视图；保留 cancelled 记录便于时间线
      })
      if (cancelled) {
        await database.update((document) => {
          document.stores.codeToolEvents.push({
            id: crypto.randomUUID(),
            conversationId: cancelled!.conversationId,
            friendId: cancelled!.friendId,
            toolName: toolNameOf(cancelled!.kind),
            detail: cancelled!.summary,
            outcome: 'cancelled',
            resultSummary: '用户取消',
            createdAt: Date.now(),
            ...(cancelled!.runId ? { runId: cancelled!.runId } : {}),
          })
        })
      }
      log('info', 'code', '取消编码动作', { id })
    },
  }
}

async function confirmWrite(database: WorkbenchDatabase, action: CodeAction): Promise<CodeAction> {
  const relativePath = stringField(action.draft, 'relativePath')
  const content = typeof action.draft.content === 'string' ? action.draft.content : ''
  const workspacePath = stringField(action.draft, 'workspacePath')
  if (!relativePath || !workspacePath) throw new AppError(400, '写入草稿不完整。')
  const resolved = resolveInWorkspace(workspacePath, relativePath)
  await mkdir(path.dirname(resolved.absolute), { recursive: true })
  await writeFile(resolved.absolute, content, 'utf8')
  const saved = await database.update((document) => {
    const row = document.stores.codeActions.find((item) => item.id === action.id)
    if (!row || row.status !== 'pending') throw new AppError(400, '这张编码确认卡已经结束。')
    row.status = 'confirmed'
    row.result = { relativePath: resolved.relative, bytes: Buffer.byteLength(content, 'utf8') }
    delete row.error
    row.updatedAt = Date.now()
    document.stores.codeToolEvents.push({
      id: crypto.randomUUID(),
      conversationId: row.conversationId,
      friendId: row.friendId,
      toolName: 'workbench_fs_write',
      detail: resolved.relative,
      outcome: 'confirmed',
      resultSummary: `已写入 ${row.result.bytes} 字节`,
      createdAt: Date.now(),
      ...(row.runId ? { runId: row.runId } : {}),
    })
    return { ...row }
  })
  log('info', 'code', '确认写入', { id: action.id, path: resolved.relative })
  return saved
}

async function confirmDelete(database: WorkbenchDatabase, action: CodeAction): Promise<CodeAction> {
  const relativePath = stringField(action.draft, 'relativePath')
  const workspacePath = stringField(action.draft, 'workspacePath')
  if (!relativePath || !workspacePath) throw new AppError(400, '删除草稿不完整。')
  const resolved = resolveInWorkspace(workspacePath, relativePath)
  if (resolved.relative === '.') throw new AppError(400, '不能删除工作目录本身。')
  await assertDeletable(resolved.absolute)
  const info = await lstat(resolved.absolute)
  if (info.isSymbolicLink() || info.isFile()) await unlink(resolved.absolute)
  else await rmdir(resolved.absolute)
  const saved = await database.update((document) => {
    const row = document.stores.codeActions.find((item) => item.id === action.id)
    if (!row || row.status !== 'pending') throw new AppError(400, '这张编码确认卡已经结束。')
    row.status = 'confirmed'
    row.result = { relativePath: resolved.relative, removed: true }
    delete row.error
    row.updatedAt = Date.now()
    document.stores.codeToolEvents.push({
      id: crypto.randomUUID(),
      conversationId: row.conversationId,
      friendId: row.friendId,
      toolName: 'workbench_fs_delete',
      detail: resolved.relative,
      outcome: 'confirmed',
      resultSummary: '已删除',
      createdAt: Date.now(),
      ...(row.runId ? { runId: row.runId } : {}),
    })
    return { ...row }
  })
  log('info', 'code', '确认删除', { id: action.id, path: resolved.relative })
  return saved
}

async function assertDeletable(absolute: string): Promise<void> {
  let info
  try {
    info = await lstat(absolute)
  } catch {
    throw new AppError(404, '要删除的路径不存在。')
  }
  if (info.isSymbolicLink() || info.isFile()) return
  if (!info.isDirectory()) throw new AppError(400, '只能删除文件或空目录。')
  const names = await readdir(absolute)
  if (names.length > 0) throw new AppError(400, '目录不是空的，不能删除。')
}

function toolNameOf(kind: CodeAction['kind']): string {
  if (kind === 'write') return 'workbench_fs_write'
  if (kind === 'delete') return 'workbench_fs_delete'
  return 'workbench_shell'
}

async function confirmShell(database: WorkbenchDatabase, action: CodeAction): Promise<CodeAction> {
  const command = stringField(action.draft, 'command')
  const cwd = stringField(action.draft, 'cwd')
  const timeoutMs =
    typeof action.draft.timeoutMs === 'number' ? action.draft.timeoutMs : DEFAULT_SHELL_TIMEOUT_MS
  if (!command || !cwd) throw new AppError(400, '命令草稿不完整。')
  assertShellStaysInWorkspace(command, cwd)
  const result = await runShell(command, cwd, timeoutMs)
  const saved = await database.update((document) => {
    const row = document.stores.codeActions.find((item) => item.id === action.id)
    if (!row || row.status !== 'pending') throw new AppError(400, '这张编码确认卡已经结束。')
    row.status = 'confirmed'
    row.result = {
      exitCode: result.exitCode,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      timedOut: result.timedOut,
    }
    delete row.error
    row.updatedAt = Date.now()
    document.stores.codeToolEvents.push({
      id: crypto.randomUUID(),
      conversationId: row.conversationId,
      friendId: row.friendId,
      toolName: 'workbench_shell',
      detail: command,
      outcome: 'confirmed',
      resultSummary: result.timedOut
        ? '超时已中断'
        : `exit ${result.exitCode}`,
      createdAt: Date.now(),
      ...(row.runId ? { runId: row.runId } : {}),
    })
    return { ...row }
  })
  log('info', 'code', '确认执行命令', { id: action.id, exitCode: result.exitCode })
  return saved
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: 1, stdout, stderr: appendCapped(stderr, error.message), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

function appendCapped(current: string, next: string): string {
  const merged = current + next
  if (merged.length <= MAX_OUTPUT_CHARS) return merged
  return merged.slice(merged.length - MAX_OUTPUT_CHARS)
}

function stringField(draft: Record<string, unknown>, key: string): string {
  const value = draft[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 极简 unified-ish diff，供确认卡预览；非完整 diff 算法。 */
export function buildSimpleDiff(relativePath: string, before: string, after: string): string {
  if (before === after) return `--- a/${relativePath}\n+++ b/${relativePath}\n(无变更)`
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  const lines = [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ 预览 @@`]
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < max; i += 1) {
    const a = beforeLines[i]
    const b = afterLines[i]
    if (a === b) {
      if (a !== undefined) lines.push(` ${a}`)
    } else {
      if (a !== undefined) lines.push(`-${a}`)
      if (b !== undefined) lines.push(`+${b}`)
    }
  }
  return lines.join('\n')
}

export type CodeActionService = ReturnType<typeof createCodeActionService>
