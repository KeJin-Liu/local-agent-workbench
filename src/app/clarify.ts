/**
 * 计划模式澄清卡：只 stage 可点选项，不写进助手正文。
 * 用户点选后记为已答，由页面把选项当作一条用户消息发出。
 */

import type { ClarifyCard } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import { AppError } from './errors.ts'

const CLARIFY_NAME = 'workbench_clarify'

/** 交给模型的内置工具。调用它只创建澄清卡。 */
export const CLARIFY_TOOL = {
  type: 'function' as const,
  function: {
    name: CLARIFY_NAME,
    description:
      '向用户出示澄清确认卡。传入一句问题和 2–6 个可点选项。' +
      '只生成卡片，不要把同一问题和序号列表写进正文。用户点选前不要写死计划或继续执行。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要用户决定的一句话' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 6,
          description: '可点选项，每项一句',
        },
      },
      required: ['question', 'options'],
    },
  },
}

export type ClarifyService = ReturnType<typeof createClarifyService>

function cleanOptions(raw: string[]): string[] {
  const seen = new Set<string>()
  const options: string[] = []
  for (const item of raw) {
    const label = item.trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    options.push(label.slice(0, 80))
    if (options.length >= 6) break
  }
  return options
}

export function createClarifyService(database: WorkbenchDatabase) {
  return {
    toolName: CLARIFY_NAME,

    async listByConversation(conversationId: string): Promise<ClarifyCard[]> {
      return (await database.read()).stores.clarifies
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },

    /** 只落卡片，不写消息。 */
    async stage(input: {
      conversationId: string
      runId?: string
      question: string
      options: string[]
    }): Promise<ClarifyCard> {
      const question = input.question.trim()
      if (!question) throw new AppError(400, '澄清问题不能为空。')
      if (!input.conversationId.trim()) throw new AppError(400, '缺少会话。')
      const options = cleanOptions(input.options)
      if (options.length < 2) throw new AppError(400, '澄清卡至少要两个选项。')
      const now = Date.now()
      const card: ClarifyCard = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        question: question.slice(0, 200),
        options,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        ...(input.runId ? { runId: input.runId } : {}),
      }
      await database.update((document) => {
        document.stores.clarifies.push(card)
      })
      log('info', 'plan', '出示澄清卡', { id: card.id, conversationId: card.conversationId })
      return card
    },

    async answer(id: string, option: string): Promise<ClarifyCard> {
      const picked = option.trim()
      if (!picked) throw new AppError(400, '请选择一个选项。')
      const now = Date.now()
      await database.update((document) => {
        const card = document.stores.clarifies.find((item) => item.id === id)
        if (!card) throw new AppError(404, '找不到这张澄清卡。')
        if (card.status === 'answered') return
        if (!card.options.includes(picked)) throw new AppError(400, '这个选项不在澄清卡上。')
        card.status = 'answered'
        card.picked = picked
        card.updatedAt = now
      })
      const saved = (await database.read()).stores.clarifies.find((item) => item.id === id)
      if (!saved) throw new AppError(404, '找不到这张澄清卡。')
      log('info', 'plan', '澄清卡已选择', { id, picked: saved.picked })
      return saved
    },
  }
}
