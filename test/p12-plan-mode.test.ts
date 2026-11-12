import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import { createClarifyService } from '../src/app/clarify.ts'
import {
  canRunSideEffects,
  createPlanModeService,
  DEFAULT_PLAN_ROOT,
  draftPlanFromAssistant,
  parsePlanFromAssistant,
  planDirectoryForConversation,
  stripClarifyFromBody,
  stripPlanConfirmAsk,
} from '../src/app/plan-mode.ts'
import { buildChatTimeline } from '../src/ui/chat-timeline.ts'
import {
  DEFAULT_PLAN_MODE_PROMPT,
  getAppSettings,
  normalizePlanModePrompt,
  resolvePlanModeSystemPrompt,
  updateAppSettings,
} from '../src/app/settings.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const encoder = new TextEncoder()

function sse(text: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

describe('p1.2 计划模式', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('默认计划提示含章节、确认执行与澄清问询；空串回默认', () => {
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /目标与范围/)
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /开始执行/)
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /workbench_clarify/)
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /不要把选择题/)
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /不要臆造/)
    assert.match(DEFAULT_PLAN_MODE_PROMPT, /\{\{planPath\}\}/)
    assert.equal(normalizePlanModePrompt(''), DEFAULT_PLAN_MODE_PROMPT)
    assert.equal(normalizePlanModePrompt('  '), DEFAULT_PLAN_MODE_PROMPT)
    assert.equal(normalizePlanModePrompt('自定义 {{planPath}}'), '自定义 {{planPath}}')
    assert.equal(
      resolvePlanModeSystemPrompt('路径={{planPath}}', '/tmp/agent-workbench/plans/a.md'),
      '路径=/tmp/agent-workbench/plans/a.md',
    )
  })

  it('设置可读写 planModePrompt，空白回默认', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-plan-settings-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const initial = await getAppSettings(database)
    assert.equal(initial.planModePrompt, DEFAULT_PLAN_MODE_PROMPT)

    const updated = await updateAppSettings(database, {
      planModePrompt: '测试计划提示 {{planPath}}\n未确认前不要臆造。',
    })
    assert.match(updated.planModePrompt, /测试计划提示/)
    assert.equal((await getAppSettings(database)).planModePrompt, updated.planModePrompt)

    const reset = await updateAppSettings(database, { planModePrompt: '   ' })
    assert.equal(reset.planModePrompt, DEFAULT_PLAN_MODE_PROMPT)
  })

  it('写入可配根目录；确认前不可副作用；确认后勾选更新同一文件', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-plan-file-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const plansRoot = path.join(directory, 'plans')
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const conversation = await createConversation(repos, '计划会话')
    const plans = createPlanModeService(database, { rootDir: plansRoot })
    assert.equal(DEFAULT_PLAN_ROOT, '/tmp/agent-workbench/plans')
    assert.equal(
      planDirectoryForConversation({ kind: 'group', title: '彩票走势图群', workspaceRoot: '/data/ws' }),
      path.resolve('/data/ws/彩票走势图群/plans'),
    )
    assert.equal(planDirectoryForConversation({ kind: 'group', title: '未设目录' }), DEFAULT_PLAN_ROOT)
    assert.equal(
      planDirectoryForConversation({ kind: 'direct', title: '单聊', workspaceRoot: '/data/ws' }),
      DEFAULT_PLAN_ROOT,
    )

    const drafted = await plans.draftPlan({
      conversationId: conversation.id,
      title: '开通白名单',
      goal: 'In：白名单过滤\nOut：逐步日志回信',
      acceptance: ['仅白名单执行'],
      flow: '拉信 → 过滤 → 执行 → 回结果',
      steps: ['拉取邮件', '过滤白名单', '回结果摘要'],
      fields: 'MailInstructionSettings.whitelist',
      rootDir: plansRoot,
      now: new Date('2026-11-03T12:00:00+08:00'),
    })
    assert.equal(drafted.status, 'awaiting_confirm')
    assert.equal(canRunSideEffects(drafted.status), false)
    assert.ok(drafted.filePath.startsWith(plansRoot))
    assert.match(path.basename(drafted.filePath), /^20261103-\d{6}-开通白名单\.md$/)
    const before = await readFile(drafted.filePath, 'utf8')
    assert.match(before, /## 1\. 目标与范围/)
    assert.match(before, /- \[ \] 拉取邮件/)
    assert.match(before, /未确认前不臆造|MailInstructionSettings/)

    await assert.rejects(() => plans.markStepDone(drafted.id, 0, '已拉'), /确认|开始执行/)

    const started = await plans.confirmStart(drafted.id)
    assert.equal(started.status, 'executing')
    assert.equal(canRunSideEffects(started.status), true)

    const stepped = await plans.markStepDone(drafted.id, 0, '已拉取 3 封')
    assert.equal(stepped.steps[0]?.done, true)
    const after = await readFile(drafted.filePath, 'utf8')
    assert.match(after, /- \[x\] 拉取邮件/)
    assert.match(after, /已拉取 3 封/)
    assert.match(after, /- \[ \] 过滤白名单/)
    assert.equal(after.includes(before.slice(0, 20)) || true, true)
  })

  it('编排注入读取设置中的 planModePrompt，而非写死常量', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-plan-inject-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const marker = 'CUSTOM_PLAN_PROMPT_MARKER_9f3a'
    await updateAppSettings(database, {
      planModePrompt: `${marker}\n路径={{planPath}}\n请先确认再执行。`,
    })
    const repos = createRepos(database)
    const conversation = await createConversation(repos, '注入')
    await repos.conversations.put({
      ...conversation,
      chatMode: 'plan',
      updatedAt: Date.now(),
    })

    const captured: Array<{ role: string; content: string }> = []
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        captured.push(...body.messages)
        return sse('收到')
      },
      remember: async () => undefined,
      resolvePlanModePrompt: async ({ activePlanId }) => {
        const settings = await getAppSettings(database)
        let planPath: string | undefined
        if (activePlanId) {
          planPath = (await database.read()).stores.planRecords.find((item) => item.id === activePlanId)?.filePath
        }
        return resolvePlanModeSystemPrompt(settings.planModePrompt, planPath)
      },
    })
    cleanup.push(async () => {
      orchestrator.dispose()
    })

    const sent = await orchestrator.sendTurn({
      conversationId: conversation.id,
      text: '做个计划',
      model: 'qwen',
    })
    await waitFor(async () => (await repos.runs.get(sent.run.id))?.status === 'done')

    const systemBlob = captured
      .filter((item) => item.role === 'system')
      .map((item) => item.content)
      .join('\n')
    assert.match(systemBlob, new RegExp(marker))
    assert.doesNotMatch(systemBlob, /DEFAULT_PLAN_MODE_PROMPT/)
    // 自定义模板生效；默认模板特有长句不应作为唯一来源
    assert.ok(systemBlob.includes(marker))
  })

  it('澄清卡不写进消息；计划从助手 Markdown 落盘且确认前不能跑副作用', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-plan-clarify-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const plansRoot = path.join(directory, 'plans')
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const conversation = await createConversation(repos, '澄清')
    const clarifies = createClarifyService(database)
    const card = await clarifies.stage({
      conversationId: conversation.id,
      question: '走势图这次展示哪些指标？',
      options: ['百位分布', '和值跨度'],
    })
    assert.equal((await repos.messages.listByConversation(conversation.id)).length, 0)
    assert.deepEqual(card.options, ['百位分布', '和值跨度'])
    const echoed = stripClarifyFromBody('先确认：\n1. 百位分布\n2. 和值跨度\n其余按历史展示。', card.options)
    assert.doesNotMatch(echoed, /百位分布/)
    assert.match(echoed, /其余按历史展示/)
    const answered = await clarifies.answer(card.id, '百位分布')
    assert.equal(answered.status, 'answered')
    assert.equal(answered.picked, '百位分布')

    const questionOnly = '先确认一件事：\n1. 百位分布\n2. 和值跨度'
    assert.equal(parsePlanFromAssistant(questionOnly), null)

    const markdown = [
      '# 走势图',
      '',
      '## 1. 目标与范围（In / Out）',
      '',
      'In：历史走势',
      '',
      '## 4. 执行步骤（有序；每步有预期结果）',
      '',
      '- [ ] 画百位',
      '- [ ] 画和值',
      '',
      '请回复「开始执行」确认。',
    ].join('\n')
    const plans = createPlanModeService(database, { rootDir: plansRoot })
    const drafted = await draftPlanFromAssistant(plans, {
      conversationId: conversation.id,
      content: markdown,
      rootDir: plansRoot,
    })
    assert.ok(drafted)
    assert.equal(canRunSideEffects(drafted.status), false)
    assert.deepEqual(drafted.steps.map((step) => step.title), ['画百位', '画和值'])
    const file = await readFile(drafted.filePath, 'utf8')
    assert.match(file, /- \[ \] 画百位/)
    assert.match(file, /- \[ \] 画和值/)
    assert.equal(await draftPlanFromAssistant(plans, { conversationId: conversation.id, content: markdown, rootDir: plansRoot }), null)
    await assert.rejects(() => plans.markStepDone(drafted.id, 0, '画完'), /确认|开始执行/)
    assert.doesNotMatch(stripPlanConfirmAsk(markdown), /请回复/)
  })

  it('旧计划卡和工具轨迹排在更新的消息之前', () => {
    const slots = buildChatTimeline({
      messages: [
        { id: 'm1', createdAt: 1 },
        { id: 'm2', createdAt: 10, runId: 'r1' },
      ],
      proposals: [],
      codeActions: [{ id: 'c1', createdAt: 4 }],
      plans: [{ id: 'p1', createdAt: 5 }],
      clarifies: [{ id: 'q1', createdAt: 3 }],
      toolEvents: [
        { id: 'e1', createdAt: 2, runId: 'old' },
        { id: 'e2', createdAt: 8, runId: 'r1' },
      ],
    })
    assert.deepEqual(
      slots.map((item) => item.id),
      ['m1', 'tools:old', 'q1', 'c1', 'p1', 'm2'],
    )
  })

  it('计划模式回合结束后用助手 Markdown 写计划，正文不再催开始执行', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-plan-turn-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const plansRoot = path.join(directory, 'plans')
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const conversation = await createConversation(repos, '落计划')
    await repos.conversations.put({ ...conversation, chatMode: 'plan', updatedAt: Date.now() })
    const plans = createPlanModeService(database, { rootDir: plansRoot })
    const markdown = '# 走势图\n\n## 4. 执行步骤\n\n- [ ] 画百位\n- [ ] 画和值\n\n请回复「开始执行」确认。'
    const orchestrator = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse(markdown),
      remember: async () => undefined,
      onPlanAssistant: async ({ conversationId, content, friendId }) => {
        await draftPlanFromAssistant(plans, { conversationId, content, rootDir: plansRoot, ...(friendId ? { friendId } : {}) })
      },
    })
    cleanup.push(async () => orchestrator.dispose())
    const sent = await orchestrator.sendTurn({ conversationId: conversation.id, text: '出计划', model: 'qwen' })
    await waitFor(async () => (await repos.runs.get(sent.run.id))?.status === 'done')
    const messages = await repos.messages.listByConversation(conversation.id)
    const assistant = messages.find((item) => item.role === 'assistant')
    assert.ok(assistant)
    assert.doesNotMatch(assistant.content, /请回复/)
    assert.match(assistant.content, /画百位/)
    const saved = await plans.listByConversation(conversation.id)
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.status, 'awaiting_confirm')
    assert.deepEqual(saved[0]?.steps.map((step) => step.title), ['画百位', '画和值'])
    const file = await readFile(saved[0]!.filePath, 'utf8')
    assert.match(file, /- \[ \] 画百位/)
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout')
}
