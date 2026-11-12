/**
 * p1.2 计划模式：写 MD → 确认门闩 → 逐步 [x] 更新同一文件。
 * 系统提示词来自全局设置 planModePrompt（可编辑），编排侧注入时用 resolvePlanModeSystemPrompt。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PlanRecord, PlanStatus, PlanStep } from '../domain/types.ts'
import { sanitizeWorkspaceSegment } from '../domain/group-workspace.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import {
  DEFAULT_PLAN_MODE_PROMPT,
  normalizePlanModePrompt,
  resolvePlanModeSystemPrompt,
} from '../storage/schema.ts'
import { AppError } from './errors.ts'

export { DEFAULT_PLAN_MODE_PROMPT, normalizePlanModePrompt, resolvePlanModeSystemPrompt }

/** 产品约定默认根目录；群有工作空间时改放到「根目录/群名称/plans」。测试可注入。 */
export const DEFAULT_PLAN_ROOT = '/tmp/agent-workbench/plans'

/**
 * 计划文件目录。群设置了工作空间就写进该目录下的「群名称/plans」，
 * 否则仍用默认的 /tmp 目录。已生成的计划不搬迁。
 */
export function planDirectoryForConversation(
  conversation: { kind?: string; title?: string; workspaceRoot?: string } | null | undefined,
  fallback = DEFAULT_PLAN_ROOT,
): string {
  const root = conversation?.kind === 'group' ? conversation.workspaceRoot?.trim() : ''
  if (!root) return fallback
  const title = sanitizeWorkspaceSegment(conversation?.title ?? '')
  return path.resolve(root, title, 'plans')
}

export type PlanDraftInput = {
  conversationId: string
  friendId?: string
  title: string
  /** In / Out */
  goal?: string
  acceptance?: string[]
  flow?: string
  steps: string[]
  fields?: string
  risks?: string
  rollback?: string
  /** 覆盖默认 /tmp/agent-workbench/plans */
  rootDir?: string
  now?: Date
}

export function canRunSideEffects(status: PlanStatus): boolean {
  return status === 'executing'
}

export function buildPlanMarkdown(input: {
  title: string
  goal?: string
  acceptance?: string[]
  flow?: string
  steps: string[]
  fields?: string
  risks?: string
  rollback?: string
}): { markdown: string; steps: PlanStep[] } {
  const title = input.title.trim() || '未命名计划'
  const steps: PlanStep[] = input.steps
    .map((item) => item.trim())
    .filter(Boolean)
    .map((stepTitle, index) => ({ index, title: stepTitle, done: false }))
  if (steps.length === 0) {
    steps.push({ index: 0, title: '梳理需求并确认范围', done: false })
  }
  const acceptance = (input.acceptance ?? []).map((item) => item.trim()).filter(Boolean)
  const acceptanceBlock =
    acceptance.length > 0
      ? acceptance.map((item) => `- [ ] ${item}`).join('\n')
      : '- [ ] 计划已获用户确认并执行完成'
  const stepBlock = steps.map((step) => `- [ ] ${step.title}`).join('\n')
  const markdown = `# ${title}

## 1. 目标与范围（In / Out）

${(input.goal ?? '').trim() || '（待补充）'}

## 2. 验收标准（可勾选、可验证）

${acceptanceBlock}

## 3. 业务流程（从触发到完成）

${(input.flow ?? '').trim() || '（待补充）'}

## 4. 执行步骤（有序；每步有预期结果）

${stepBlock}

## 5. 相关字段 / 接口 / 数据（表、路径、API，列入明细）

${(input.fields ?? '').trim() || '（不明确处先向用户确认，未确认前不臆造）'}

## 6. 风险与依赖

${(input.risks ?? '').trim() || '（待补充）'}

## 7. 回滚或失败处理

${(input.rollback ?? '').trim() || '（待补充）'}
`
  return { markdown, steps }
}

function slugTitle(title: string): string {
  const raw = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
  return raw || 'plan'
}

function stampName(now: Date, title: string): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return `${y}${m}${d}-${hh}${mm}${ss}-${slugTitle(title)}.md`
}

/** 把执行步骤区块里第 N 个 `- [ ]` 换成 `- [x]`，并可追加结果注释。 */
export function markCheckboxInMarkdown(markdown: string, stepIndex: number, result?: string): string {
  let seen = -1
  const lines = markdown.split('\n')
  let inSteps = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^##\s*4[.\s]/.test(line)) {
      inSteps = true
      continue
    }
    if (inSteps && /^##\s+/.test(line)) break
    if (!inSteps) continue
    if (/^- \[[ xX]\] /.test(line)) {
      seen += 1
      if (seen === stepIndex) {
        const text = line.replace(/^- \[[ xX]\] /, '')
        const note = result?.trim() ? ` — ${result.trim()}` : ''
        lines[i] = `- [x] ${text.replace(/\s—\s.*$/, '')}${note}`
        return lines.join('\n')
      }
    }
  }
  throw new AppError(400, `找不到第 ${stepIndex + 1} 个执行步骤勾选框。`)
}

export type PlanModeService = ReturnType<typeof createPlanModeService>

export function createPlanModeService(
  database: WorkbenchDatabase,
  options: { rootDir?: string } = {},
) {
  const defaultRoot = options.rootDir ?? DEFAULT_PLAN_ROOT

  async function readPlan(id: string): Promise<PlanRecord> {
    const plan = (await database.read()).stores.planRecords.find((item) => item.id === id)
    if (!plan) throw new AppError(404, '找不到这个计划')
    return plan
  }

  return {
    defaultRoot,

    async listByConversation(conversationId: string): Promise<PlanRecord[]> {
      return (await database.read()).stores.planRecords
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    get: readPlan,

    /** 写 MD + 落 awaiting_confirm；确认前不可跑副作用。 */
    async draftPlan(input: PlanDraftInput): Promise<PlanRecord> {
      const title = input.title.trim()
      if (!title) throw new AppError(400, '计划标题不能为空。')
      if (!input.conversationId.trim()) throw new AppError(400, '缺少会话。')
      const { markdown, steps } = buildPlanMarkdown(input)
      const rootDir = path.resolve(input.rootDir ?? defaultRoot)
      await mkdir(rootDir, { recursive: true })
      const now = input.now ?? new Date()
      const filePath = path.join(rootDir, stampName(now, title))
      await writeFile(filePath, markdown, 'utf8')
      const ts = Date.now()
      const record: PlanRecord = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        title,
        filePath,
        status: 'awaiting_confirm',
        steps,
        createdAt: ts,
        updatedAt: ts,
        ...(input.friendId ? { friendId: input.friendId } : {}),
      }
      await database.update((document) => {
        document.stores.planRecords.push(record)
        const conversation = document.stores.conversations.find((item) => item.id === input.conversationId)
        if (conversation) {
          conversation.activePlanId = record.id
          conversation.chatMode = conversation.chatMode ?? 'plan'
          conversation.updatedAt = ts
        }
      })
      log('info', 'plan', '计划已写入，等待确认执行', { id: record.id, filePath })
      return record
    },

    async confirmStart(id: string): Promise<PlanRecord> {
      const current = await readPlan(id)
      if (current.status !== 'awaiting_confirm') {
        throw new AppError(400, '只有待确认的计划可以开始执行。')
      }
      const ts = Date.now()
      await database.update((document) => {
        const plan = document.stores.planRecords.find((item) => item.id === id)
        if (!plan) throw new AppError(404, '找不到这个计划')
        plan.status = 'executing'
        plan.updatedAt = ts
      })
      log('info', 'plan', '用户确认开始执行计划', { id })
      return readPlan(id)
    },

    async cancel(id: string): Promise<PlanRecord> {
      const current = await readPlan(id)
      if (current.status === 'done') throw new AppError(400, '已完成的计划不能取消。')
      const ts = Date.now()
      await database.update((document) => {
        const plan = document.stores.planRecords.find((item) => item.id === id)
        if (!plan) throw new AppError(404, '找不到这个计划')
        plan.status = 'cancelled'
        plan.updatedAt = ts
      })
      return readPlan(id)
    },

    /** 仅 executing 时可勾选；更新同一 MD 文件。 */
    async markStepDone(id: string, stepIndex: number, result?: string): Promise<PlanRecord> {
      const current = await readPlan(id)
      if (!canRunSideEffects(current.status)) {
        throw new AppError(400, '请先确认「开始执行」后再勾选步骤。')
      }
      const step = current.steps.find((item) => item.index === stepIndex)
      if (!step) throw new AppError(400, '步骤序号不正确。')
      const markdown = await readFile(current.filePath, 'utf8')
      const nextMarkdown = markCheckboxInMarkdown(markdown, stepIndex, result)
      await writeFile(current.filePath, nextMarkdown, 'utf8')
      const ts = Date.now()
      await database.update((document) => {
        const plan = document.stores.planRecords.find((item) => item.id === id)
        if (!plan) throw new AppError(404, '找不到这个计划')
        const row = plan.steps.find((item) => item.index === stepIndex)
        if (row) {
          row.done = true
          if (result?.trim()) row.result = result.trim()
        }
        if (plan.steps.every((item) => item.done)) plan.status = 'done'
        plan.updatedAt = ts
      })
      log('info', 'plan', '计划步骤已勾选', { id, stepIndex, doneAll: (await readPlan(id)).status === 'done' })
      return readPlan(id)
    },

    assertSideEffectsAllowed(plan: PlanRecord): void {
      if (!canRunSideEffects(plan.status)) {
        throw new AppError(400, '计划尚未确认开始执行，不能跑副作用步骤。')
      }
    },
  }
}

type ParsedPlan = {
  title: string
  goal?: string
  acceptance?: string[]
  flow?: string
  steps: string[]
  fields?: string
  risks?: string
  rollback?: string
}

function sectionBodies(markdown: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string[] }> = []
  let current: { heading: string; body: string[] } | null = null
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      if (current) sections.push(current)
      current = { heading: heading[1].trim(), body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  if (current) sections.push(current)
  return sections.map((section) => ({ heading: section.heading, body: section.body.join('\n').trim() }))
}

function listItems(body: string): string[] {
  const items: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const box = /^[-*]\s+\[[ xX]\]\s+(.+)$/.exec(trimmed)
    if (box) {
      items.push(box[1].replace(/\s—\s.*$/, '').trim())
      continue
    }
    const numbered = /^\d+[.、．)]\s+(.+)$/.exec(trimmed)
    if (numbered) {
      items.push(numbered[1].trim())
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bullet) items.push(bullet[1].trim())
  }
  return items.filter(Boolean)
}

/**
 * 从助手回复里抽出计划章节。没有「步骤/执行」结构时返回 null，
 * 避免把澄清用的 1. 2. 3. 误当成计划。
 */
export function parsePlanFromAssistant(content: string): ParsedPlan | null {
  const text = content.trim()
  if (!text) return null
  const sections = sectionBodies(text)
  const find = (pattern: RegExp) => sections.find((section) => pattern.test(section.heading))?.body
  const stepBody = find(/步骤|执行/)
  const steps = (stepBody ? listItems(stepBody) : []).filter(Boolean)
  const fallbackSteps = text
    .split('\n')
    .map((line) => /^[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line.trim())?.[1]?.replace(/\s—\s.*$/, '').trim() ?? '')
    .filter(Boolean)
  const resolvedSteps = steps.length > 0 ? steps : fallbackSteps
  const looksLikePlan =
    sections.some((section) => /目标|步骤|执行|验收|流程/.test(section.heading)) || fallbackSteps.length >= 2
  if (!looksLikePlan || resolvedSteps.length === 0) return null
  const heading = text.split('\n').find((line) => /^#\s+\S/.test(line.trim()))
  const title = (heading ? heading.trim().replace(/^#\s+/, '') : resolvedSteps[0] ?? '计划').slice(0, 40)
  const acceptanceBody = find(/验收/)
  const goal = find(/目标|范围/)
  const flow = find(/流程/)
  const fields = find(/字段|接口|数据/)
  const risks = find(/风险/)
  const rollback = find(/回滚|失败/)
  return {
    title: title || '计划',
    steps: resolvedSteps,
    ...(goal ? { goal } : {}),
    ...(acceptanceBody ? { acceptance: listItems(acceptanceBody) } : {}),
    ...(flow ? { flow } : {}),
    ...(fields ? { fields } : {}),
    ...(risks ? { risks } : {}),
    ...(rollback ? { rollback } : {}),
  }
}

/**
 * 会话里还没有待确认或执行中的计划时，把助手 Markdown 落成一份计划。
 * 已有门闩计划则不再另起一份，避免后一条消息把确认卡顶走。
 */
export async function draftPlanFromAssistant(
  plans: PlanModeService,
  input: { conversationId: string; content: string; friendId?: string; rootDir?: string },
): Promise<PlanRecord | null> {
  const existing = await plans.listByConversation(input.conversationId)
  if (existing.some((item) => item.status === 'awaiting_confirm' || item.status === 'executing')) return null
  const parsed = parsePlanFromAssistant(input.content)
  if (!parsed) return null
  return plans.draftPlan({
    conversationId: input.conversationId,
    title: parsed.title,
    steps: parsed.steps,
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
    ...(input.friendId ? { friendId: input.friendId } : {}),
    ...(parsed.goal ? { goal: parsed.goal } : {}),
    ...(parsed.acceptance?.length ? { acceptance: parsed.acceptance } : {}),
    ...(parsed.flow ? { flow: parsed.flow } : {}),
    ...(parsed.fields ? { fields: parsed.fields } : {}),
    ...(parsed.risks ? { risks: parsed.risks } : {}),
    ...(parsed.rollback ? { rollback: parsed.rollback } : {}),
  })
}

/** 计划已经能出确认卡时，去掉正文里催用户回复「开始执行」的句子。 */
export function stripPlanConfirmAsk(content: string): string {
  const kept = content.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('- [')) return true
    if (trimmed.length > 80) return true
    return !(/开始执行/.test(trimmed) && /确认|回复|还缺|请/.test(trimmed))
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 澄清选项只留在卡上，从助手正文里拿掉相同的一行。 */
export function stripClarifyFromBody(content: string, phrases: string[]): string {
  const banned = new Set(phrases.map((item) => item.trim()).filter(Boolean))
  if (banned.size === 0) return content.trim()
  const kept = content.split('\n').filter((line) => {
    const trimmed = line.trim()
    const bare = trimmed.replace(/^\d+[.、．)\]]\s*/, '').replace(/^[-*]\s+/, '')
    return !banned.has(trimmed) && !banned.has(bare)
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
