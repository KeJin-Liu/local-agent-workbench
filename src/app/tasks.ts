/**
 * 自动化任务。立即运行可以被终止；历史记在任务自己身上。
 */

import type { AutomationTask, TaskHistoryEntry, TaskSchedule } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import { AppError } from './errors.ts'
import { cronMatches, parseCron } from './cron.ts'

export type TaskDraft = {
  id?: string
  name: string
  friendId: string
  prompt?: string
  kind?: AutomationTask['kind']
  schedule?: TaskSchedule
  cron?: string
  targetConversationId?: string
  scope?: AutomationTask['scope']
  friendIds?: string[]
  enabled?: boolean
}

export type TaskRunner = (task: AutomationTask, signal: AbortSignal) => Promise<string>

const HISTORY_LIMIT = 20

export function createTaskService(database: WorkbenchDatabase, runImpl: TaskRunner) {
  const live = new Map<string, AbortController>()
  const scheduledKeys = new Map<string, string>()
  const badCron = new Set<string>()
  let schedulerTimer: ReturnType<typeof setInterval> | undefined
  let ticking = false

  async function read(id: string): Promise<AutomationTask> {
    const task = (await database.read()).stores.tasks.find((item) => item.id === id)
    if (!task) throw new AppError(404, '找不到这个任务')
    return task
  }

  async function runTask(id: string): Promise<AutomationTask> {
    if (live.has(id)) throw new AppError(400, '这个任务正在运行。')
    const current = await read(id)
    const controller = new AbortController()
    live.set(id, controller)
    const entry: TaskHistoryEntry = { id: crypto.randomUUID(), status: 'running', startedAt: Date.now() }
    await patch(database, id, (task) => {
      task.lastStatus = 'running'
      delete task.lastError
      task.history = [entry, ...task.history].slice(0, HISTORY_LIMIT)
      task.updatedAt = Date.now()
    })
    log('info', 'tasks', '开始运行', { id })
    try {
      const result = await runImpl(current, controller.signal)
      await patch(database, id, (task) => {
        const item = task.history.find((row) => row.id === entry.id)
        if (item) {
          item.status = 'success'
          item.result = result
          item.finishedAt = Date.now()
        }
        task.lastStatus = 'success'
        task.lastRunAt = Date.now()
        delete task.lastError
        task.updatedAt = Date.now()
      })
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const message = error instanceof Error ? error.message : '运行失败'
      await patch(database, id, (task) => {
        const item = task.history.find((row) => row.id === entry.id)
        if (item) {
          item.status = aborted ? 'cancelled' : 'error'
          item.error = message
          item.finishedAt = Date.now()
        }
        task.lastStatus = aborted ? 'cancelled' : 'error'
        task.lastError = message
        task.lastRunAt = Date.now()
        task.updatedAt = Date.now()
      })
      if (!aborted) throw error instanceof AppError ? error : new AppError(400, message)
    } finally {
      live.delete(id)
    }
    return read(id)
  }

  /** 同一任务同一分钟只排一次；上一分钟的运行还没结束就等下一轮。 */
  function minuteKey(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  /** 扫一遍任务表，把当前分钟命中的定时任务跑起来。15 秒一轮，可在测试里手动调用。 */
  async function tick(now: Date = new Date()): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const document = await database.read()
      const key = minuteKey(now)
      for (const task of document.stores.tasks) {
        if (!task.enabled || task.schedule !== 'cron' || !task.cron) continue
        if (live.has(task.id)) continue
        if (scheduledKeys.get(task.id) === key) continue
        // 同一分钟刚跑完（含重启前的运行）不重复触发。
        if (task.lastRunAt && minuteKey(new Date(task.lastRunAt)) === key) continue
        let matched = false
        try {
          matched = cronMatches(task.cron, now)
        } catch (error) {
          if (!badCron.has(task.cron)) {
            badCron.add(task.cron)
            log('warn', 'tasks', 'Cron 表达式无法解析，已跳过', {
              id: task.id,
              cron: task.cron,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          continue
        }
        if (!matched) continue
        scheduledKeys.set(task.id, key)
        log('info', 'tasks', '定时命中，开始运行', { id: task.id, cron: task.cron, at: now.toISOString() })
        void runTask(task.id).catch((error) => {
          log('warn', 'tasks', '定时运行失败', {
            id: task.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    } catch (error) {
      log('warn', 'tasks', '定时检查失败', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      ticking = false
    }
  }

  function startScheduler(): void {
    if (schedulerTimer) return
    schedulerTimer = setInterval(() => {
      void tick()
    }, 15_000)
    // 测试/命令行里不要因为这个定时器把进程挂住。
    ;(schedulerTimer as unknown as { unref?: () => void }).unref?.()
    void tick()
  }

  function stopScheduler(): void {
    if (schedulerTimer) clearInterval(schedulerTimer)
    schedulerTimer = undefined
  }

  return {
    async list(): Promise<AutomationTask[]> {
      const tasks = (await database.read()).stores.tasks
      return tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async upsert(draft: TaskDraft): Promise<AutomationTask> {
      const name = draft.name.trim()
      if (!name) throw new AppError(400, '任务名称不能为空。')
      const friendId = draft.friendId.trim()
      if (!friendId) throw new AppError(400, '任务要绑定一个好友。')
      const now = Date.now()
      const existing = draft.id ? (await database.read()).stores.tasks.find((item) => item.id === draft.id) : undefined
      const schedule = draft.schedule ?? existing?.schedule ?? 'manual'
      const cron = (draft.cron ?? existing?.cron ?? '').trim()
      if (schedule === 'cron' && !cron) throw new AppError(400, '定时任务要填写 Cron。')
      if (schedule === 'cron') {
        try {
          parseCron(cron)
        } catch (error) {
          throw new AppError(400, error instanceof Error ? error.message : 'Cron 格式不对')
        }
      }
      const kind = draft.kind ?? existing?.kind ?? 'prompt'
      const task: AutomationTask = {
        id: existing?.id ?? draft.id ?? crypto.randomUUID(),
        name,
        friendId,
        prompt: (draft.prompt ?? existing?.prompt ?? '').trim(),
        kind,
        schedule,
        scope: draft.scope ?? existing?.scope ?? 'global',
        enabled: draft.enabled ?? existing?.enabled ?? true,
        lastStatus: existing?.lastStatus ?? 'none',
        history: existing?.history ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(cron ? { cron } : {}),
        ...(draft.targetConversationId?.trim() || existing?.targetConversationId
          ? { targetConversationId: (draft.targetConversationId?.trim() || existing?.targetConversationId) as string }
          : {}),
        ...((draft.friendIds ?? existing?.friendIds)?.length
          ? { friendIds: draft.friendIds ?? existing?.friendIds }
          : {}),
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
        ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      }
      await database.update((document) => {
        if (!document.stores.friends.some((item) => item.id === friendId)) {
          throw new AppError(400, '绑定的好友不存在。')
        }
        const index = document.stores.tasks.findIndex((item) => item.id === task.id)
        if (index === -1) document.stores.tasks.push(task)
        else document.stores.tasks[index] = task
      })
      scheduledKeys.delete(task.id)
      badCron.clear()
      log('info', 'tasks', existing ? '更新任务' : '新建任务', { id: task.id, schedule: task.schedule })
      return task
    },

    async remove(id: string): Promise<void> {
      live.get(id)?.abort()
      live.delete(id)
      scheduledKeys.delete(id)
      await database.update((document) => {
        document.stores.tasks = document.stores.tasks.filter((item) => item.id !== id)
      })
      log('info', 'tasks', '删除任务', { id })
    },

    run: runTask,
    tick,
    startScheduler,
    stopScheduler,

    async stop(id: string): Promise<AutomationTask> {
      const controller = live.get(id)
      if (!controller) throw new AppError(400, '这个任务没有在运行。')
      controller.abort()
      log('info', 'tasks', '终止运行', { id })
      return read(id)
    },
  }
}

async function patch(
  database: WorkbenchDatabase,
  id: string,
  change: (task: AutomationTask) => void,
): Promise<void> {
  await database.update((document) => {
    const task = document.stores.tasks.find((item) => item.id === id)
    if (!task) throw new AppError(404, '找不到这个任务')
    change(task)
  })
}

export type TaskService = ReturnType<typeof createTaskService>
