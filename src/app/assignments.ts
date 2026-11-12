/**
 * 群主把任务指派给群里的好友，结果写回同一条群会话。
 */

import type { Assignment, Conversation, Friend, Message } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import { AppError } from './errors.ts'

export type AssigneeRunInput = {
  assignment: Assignment
  friend: Friend
  conversation: Conversation
  signal: AbortSignal
  /** 执行中的进度人话；写进 assignment.progress，页面轮询可见。 */
  onProgress?: (text: string) => Promise<void>
}

export type AssigneeOutput = {
  content: string
  /** 实际调用的工具步数。 */
  steps?: number
}

/** 兼容旧实现的纯文本返回；新实现返回 content + steps。 */
export type AssigneeRunner = (input: AssigneeRunInput) => Promise<string | AssigneeOutput>

export function createAssignmentService(database: WorkbenchDatabase, runImpl: AssigneeRunner) {
  const inflight = new Map<string, Promise<void>>()
  const controllers = new Map<string, AbortController>()

  async function read(id: string): Promise<Assignment> {
    const assignment = (await database.read()).stores.assignments.find((item) => item.id === id)
    if (!assignment) throw new AppError(404, '找不到这个指派')
    return assignment
  }

  async function execute(id: string): Promise<void> {
    const current = await read(id)
    if (current.status !== 'pending') return
    const document = await database.read()
    const friend = document.stores.friends.find((item) => item.id === current.toFriendId)
    const conversation = document.stores.conversations.find((item) => item.id === current.conversationId)
    if (!friend || !conversation) {
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment || assignment.status !== 'pending') return
        assignment.error = '指派的好友或群不在了。'
        assignment.updatedAt = Date.now()
      })
      return
    }
    const controller = new AbortController()
    controllers.set(id, controller)
    const report = async (text: string) => {
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment || assignment.status !== 'pending') return
        assignment.progress = text
        assignment.updatedAt = Date.now()
      })
    }
    try {
      await report('已接单，正在准备工具与上下文…')
      const output = await runImpl({
        assignment: current,
        friend,
        conversation,
        signal: controller.signal,
        onProgress: report,
      })
      const text = (typeof output === 'string' ? output : output.content).trim()
      const steps = typeof output === 'string' ? undefined : output.steps
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment || assignment.status !== 'pending') return
        // 结果至少比指派卡晚 1ms，避免同毫秒下按 id 排序颠倒
        const now = Math.max(Date.now(), assignment.createdAt + 1)
        const message: Message = {
          id: crypto.randomUUID(),
          conversationId: assignment.conversationId,
          role: 'assistant',
          content: text || '完成',
          speakerFriendId: assignment.toFriendId,
          status: 'complete',
          kind: 'result',
          assignmentId: assignment.id,
          createdAt: now,
        }
        draft.stores.messages.push(message)
        assignment.status = 'done'
        assignment.resultMessageId = message.id
        delete assignment.error
        delete assignment.progress
        if (typeof steps === 'number') assignment.steps = steps
        assignment.updatedAt = now
      })
      log('info', 'assignments', '指派结果已回流', { id, conversationId: current.conversationId, steps })
    } catch (error) {
      const message = error instanceof Error ? error.message : '指派没有完成'
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment || assignment.status !== 'pending') return
        assignment.error = message
        delete assignment.progress
        assignment.updatedAt = Date.now()
      })
      log('warn', 'assignments', '指派执行失败，结果未写入', { id, error: message })
    } finally {
      controllers.delete(id)
    }
  }

  function track(id: string): void {
    const job = execute(id).finally(() => inflight.delete(id))
    inflight.set(id, job)
  }

  return {
    /** 测试里等后台执行结束。页面靠会话轮询看到结果。 */
    async settle(id: string): Promise<Assignment> {
      await inflight.get(id)
      return read(id)
    },

    async create(conversationId: string, toFriendId: string, instruction: string): Promise<Assignment> {
      const text = instruction.trim()
      if (!text) throw new AppError(400, '任务说明不能为空。')
      const document = await database.read()
      const conversation = document.stores.conversations.find((item) => item.id === conversationId)
      if (!conversation) throw new AppError(404, '找不到这个会话')
      if (conversation.kind !== 'group') throw new AppError(400, '只有群聊可以指派。')
      if (conversation.archived) throw new AppError(400, '这个群已归档，取消归档后才能继续聊天。')
      const owner = document.stores.friends.find((friend) => friend.isOwnerTemplate && conversation.friendIds.includes(friend.id))
      if (!owner) throw new AppError(400, '群里没有群主，不能指派。')
      if (!conversation.friendIds.includes(toFriendId)) throw new AppError(400, '只能指派给本群里的好友。')
      if (toFriendId === owner.id) throw new AppError(400, '群主不用指派给自己。')
      const assignee = document.stores.friends.find((friend) => friend.id === toFriendId)
      if (!assignee) throw new AppError(400, '指派的好友不存在。')
      const now = Date.now()
      const assignment: Assignment = {
        id: crypto.randomUUID(),
        conversationId,
        fromFriendId: owner.id,
        toFriendId,
        instruction: text,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      const card: Message = {
        id: crypto.randomUUID(),
        conversationId,
        role: 'assistant',
        content: text,
        speakerFriendId: owner.id,
        status: 'complete',
        kind: 'assign',
        assignmentId: assignment.id,
        createdAt: now,
      }
      await database.update((draft) => {
        draft.stores.assignments.push(assignment)
        draft.stores.messages.push(card)
      })
      log('info', 'assignments', '群主发起指派', { id: assignment.id, conversationId, toFriendId })
      track(assignment.id)
      return assignment
    },

    async retry(id: string): Promise<Assignment> {
      const current = await read(id)
      if (current.status !== 'pending') throw new AppError(400, '这个指派已经结束。')
      if (inflight.has(id)) throw new AppError(400, '这个指派正在执行。')
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment) return
        delete assignment.error
        delete assignment.progress
        delete assignment.steps
      })
      track(id)
      log('info', 'assignments', '重试指派', { id })
      return read(id)
    },

    async cancel(id: string): Promise<Assignment> {
      await database.update((draft) => {
        const assignment = draft.stores.assignments.find((item) => item.id === id)
        if (!assignment || assignment.status !== 'pending') throw new AppError(400, '这个指派已经结束。')
        assignment.status = 'cancelled'
        delete assignment.error
        delete assignment.progress
        assignment.updatedAt = Date.now()
      })
      // 停掉还在跑的工具循环，别让取消后继续打模型。
      controllers.get(id)?.abort()
      log('info', 'assignments', '取消指派', { id })
      return read(id)
    },
  }
}

export type AssignmentService = ReturnType<typeof createAssignmentService>
