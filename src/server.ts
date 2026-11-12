/**
 * 本地工作台宿主。一个 Node 进程同时提供页面和接口：
 * 开发时把 Vite 挂成中间件，构建之后改发 dist/。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ViteDevServer } from 'vite'
import { createAvatarService } from './app/avatars.ts'
import { createMediaService } from './app/media.ts'
import { AppError } from './app/errors.ts'
import { log } from './logger.ts'
import { seedIfEmpty } from './storage/seed.ts'
import { openDatabase } from './storage/database.ts'
import { createAvatarFiles } from './storage/avatar-files.ts'
import { createMediaFiles } from './storage/media-files.ts'
import { createRepos } from './storage/repos/index.ts'
import { handleLocal, type ApiContext } from './http/routes.ts'
import { createOrchestrator } from './session/orchestrator.ts'
import { createAssigneeRunner } from './session/assignee.ts'
import { getAppSettings } from './app/settings.ts'
import { normalizeMailTaskPrompt, resolvePlanModeSystemPrompt } from './storage/schema.ts'
import { createVault, migratePlaintextSecrets } from './vault/service.ts'
import { resolveProviderApiKey } from './app/providers.ts'
import type { MailTransport } from './app/mail-transport.ts'
import { createAssignmentService } from './app/assignments.ts'
import { createMcpService } from './app/mcp.ts'
import { createProposalService, isProposalKind } from './app/proposals.ts'
import { createCodeActionService } from './app/code-actions.ts'
import { createPlanModeService, draftPlanFromAssistant, planDirectoryForConversation } from './app/plan-mode.ts'
import { createClarifyService } from './app/clarify.ts'
import { CODE_TOOLS, callCodeTool, isCodeToolName } from './app/code-tools.ts'
import { canReadCode } from './app/code-workspace.ts'
import { createTaskService } from './app/tasks.ts'
import {
  buildWorkInstructionText,
  createMailInstructionService,
  createMailTransport,
  isMailPollTask,
  resolveFriendDirectConversation,
  runMailPollPipeline,
} from './app/mail-instructions.ts'
import { resolveMailRoute } from './app/mail-route.ts'
import { chat } from './llm/client.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const defaultsDir = fileURLToPath(new URL('./assets/avatars/', import.meta.url))

export type HostOptions = {
  dataFile?: string
  uploadDir?: string
  mediaDir?: string
  port?: number
  host?: string
  /** dev 挂 Vite；prod 发 dist；none 只开接口，给测试用。 */
  ui?: 'dev' | 'prod' | 'none'
  /** 覆盖 SEND_DELAY_MS。测试可以把它设得很短。 */
  sendDelayMs?: number
  /** 是否启动定时任务调度。默认 dev/prod 启动，ui:'none'（测试/纯接口）不启动。 */
  scheduler?: boolean
  /** 测试注入：替换真 IMAP/SMTP；生产不传。 */
  mailTransport?: MailTransport
}

export type Host = {
  port: number
  server: ReturnType<typeof createServer>
  close: () => Promise<void>
}

/** 打开本地库、种子和 HTTP 服务。调用方负责 listen 之后的日志。 */
export async function createHost(options: HostOptions = {}): Promise<Host> {
  const dataFile = options.dataFile ?? path.join(projectRoot, 'data', 'agent_workbench.json')
  const uploadDir = options.uploadDir ?? path.join(projectRoot, 'data', 'avatars')
  const mediaDir = options.mediaDir ?? path.join(projectRoot, 'data', 'media')
  const ui = options.ui ?? (process.env.NODE_ENV === 'production' ? 'prod' : 'dev')
  const database = await openDatabase(dataFile)
  const repos = createRepos(database)
  const files = createAvatarFiles(defaultsDir, uploadDir)
  const avatars = createAvatarService(files)
  const media = createMediaService(createMediaFiles(mediaDir))
  const vault = createVault(database, path.join(path.dirname(dataFile), 'vault.key'))
  // 先把旧的明文 apiKey 收进保险库，再跑种子。种子会写盘，写盘时明文会被擦掉。
  await migratePlaintextSecrets(database, vault)
  await seedIfEmpty(database)
  const mcp = createMcpService(database, (id) => vault.reveal(id))
  const proposals = createProposalService(database, vault)
  const codeActions = createCodeActionService(database)
  const plans = createPlanModeService(database)
  const clarifies = createClarifyService(database)
  const assignments = createAssignmentService(
    database,
    createAssigneeRunner({
      repos,
      resolveApiKey: (provider) => resolveProviderApiKey(provider, (id) => vault.reveal(id)),
      mcpCatalog: (target) => mcp.catalogForChat(target),
      codeTools: {
        tools: CODE_TOOLS,
        isBound: (friend) => canReadCode(friend),
        call: async (name, args, ctx) => {
          if (!isCodeToolName(name)) return `未知编码工具：${name}`
          return callCodeTool(name, args, { ...ctx, actions: codeActions })
        },
      },
    }),
  )
  const mailInstructions = createMailInstructionService(database)
  const mailTransport =
    options.mailTransport ??
    createMailTransport({
      reveal: (id) => vault.reveal(id),
      // 开发测：WORKBENCH_MAIL_DRY_RUN=1 时 SMTP 只打日志不真发；默认真发。
      dryRunSmtp: process.env.WORKBENCH_MAIL_DRY_RUN === '1',
    })
  const turns = createOrchestrator({
    repos,
    delayMs: options.sendDelayMs,
    resolveSettingsDelayMs: async () => {
      const settings = await getAppSettings(database)
      return settings.sendWaitSeconds * 1000
    },
    resolveApiKey: (provider) => resolveProviderApiKey(provider, (id) => vault.reveal(id)),
    mcpCatalog: (target) => mcp.catalogForChat(target),
    loadImage: async (attachment) => {
      const stored = await media.files.resolve(attachment.id)
      if (!stored) return null
      const data = await media.files.read(stored.fileName)
      return data ? { mime: stored.mime, data } : null
    },
    propose: async (conversationId, args) => {
      const kind = isProposalKind(args.kind) ? args.kind : 'skill'
      const name = typeof args.name === 'string' ? args.name : ''
      const proposal = await proposals.stage({
        conversationId,
        kind,
        name,
        summary: typeof args.summary === 'string' ? args.summary : name,
        draft: args,
      })
      return `已出示确认卡 ${proposal.id}，用户确认前不会保存。`
    },
    getConfig: async (args) => {
      const section = typeof args.section === 'string' ? args.section : 'all'
      return proposals.getConfigSummary(section)
    },
    clarify: async (conversationId, runId, args) => {
      const question = typeof args.question === 'string' ? args.question : ''
      const options = Array.isArray(args.options)
        ? args.options.filter((item): item is string => typeof item === 'string')
        : []
      const card = await clarifies.stage({ conversationId, runId, question, options })
      return `已出示澄清卡 ${card.id}。不要在正文重复问题和选项，等用户点选后再继续。`
    },
    onPlanAssistant: async ({ conversationId, content, friendId }) => {
      const conversation = await repos.conversations.get(conversationId)
      if (!conversation || conversation.chatMode !== 'plan') return
      await draftPlanFromAssistant(plans, {
        conversationId,
        content,
        rootDir: planDirectoryForConversation(conversation),
        ...(friendId ? { friendId } : {}),
      })
    },
    codeTools: {
      tools: CODE_TOOLS,
      isBound: (friend) => canReadCode(friend),
      call: async (name, args, ctx) => {
        if (!isCodeToolName(name)) return `未知编码工具：${name}`
        return callCodeTool(name, args, { ...ctx, actions: codeActions })
      },
    },
    onGroupHandoff: async ({ conversationId, toFriendId, instruction }) => {
      // 群主在回复里 @ 了群友：自动开一条指派，结果仍回流本群。
      const assignment = await assignments.create(conversationId, toFriendId, instruction)
      log('info', 'assignments', '群主 @ 自动交办', {
        conversationId,
        toFriendId,
        assignmentId: assignment.id,
      })
    },
    resolvePlanModePrompt: async ({ activePlanId }) => {
      const settings = await getAppSettings(database)
      let planPath: string | undefined
      if (activePlanId) {
        const plan = (await database.read()).stores.planRecords.find((item) => item.id === activePlanId)
        planPath = plan?.filePath
      }
      return resolvePlanModeSystemPrompt(settings.planModePrompt, planPath)
    },
  })
  await turns.recoverOrphanedRuns()
  const tasks = createTaskService(database, async (task, signal) => {
    // p1.3.1：系统拉信短路 — 应用 IMAP/白名单/下发会话/SMTP，不进好友 prompt。
    if (isMailPollTask(task)) {
      return runMailPollPipeline({
        database,
        repos,
        task,
        signal,
        mailService: mailInstructions,
        fetchInbox: mailTransport.fetchInbox,
        sendSmtp: mailTransport.sendSmtp,
        dispatch: async ({ conversationId, instructionText, mail, signal }) => {
          const conf = (await getAppSettings(database)).mailInstructions
          const autoConfirm = conf.autoConfirm !== false
          const extraSystemPrompt = autoConfirm
            ? normalizeMailTaskPrompt(conf.taskPrompt)
            : `${normalizeMailTaskPrompt(conf.taskPrompt)}

注意：本次「无人值守自动执行」已关闭，写文件 / 命令会生成确认卡，无人值守下无法完成。请只做只读检查，并在结果里说明需要人工确认的改动。`
          const friends = await repos.friends.list()
          const groups = (await repos.conversations.list()).filter((item) => item.kind === 'group')
          const route = resolveMailRoute({
            body: mail.body,
            subject: mail.subject,
            friends,
            groups,
          })
          let targetId = conversationId
          let text = instructionText
          if (route?.kind === 'friend') {
            targetId = (await resolveFriendDirectConversation(repos, route.id)).id
            text = buildWorkInstructionText({ ...mail, body: route.instruction })
            log('info', 'mail', '邮件点名好友，改交给对方', { friendId: route.id, name: route.name })
          } else if (route?.kind === 'group') {
            targetId = route.id
            text = buildWorkInstructionText({ ...mail, body: route.instruction })
            log('info', 'mail', '邮件点名群聊，改交到该群', { conversationId: route.id, name: route.name })
          }
          const result = await turns.sendTurn({
            conversationId: targetId,
            text,
            delayMs: 0,
            extraSystemPrompt,
            autoConfirmCode: autoConfirm,
            // 绑定好友的聊天模型为准。目标会话里的旧图片不能把邮件改到视觉插件。
            skipVision: true,
          })
          // 人不在电脑旁：等模型和工具真正跑完，再把结果写回邮件，而不是只报“已下发”。
          const finished = await turns.waitForRun(result.run.id, {
            timeoutMs: 15 * 60_000,
            signal,
          })
          if (finished.status !== 'done') {
            return {
              ok: false,
              summary: `邮件任务没有完成（${finished.status}）。`,
              error: finished.error || '回合未完成',
            }
          }
          const messages = await repos.messages.listByConversation(targetId)
          const assistant = messages
            .filter((item) => item.runId === result.run.id && item.role === 'assistant')
            .at(-1)
          const handed = route ? `已交给${route.name}。\n` : ''
          const summary = `${handed}${assistant?.content?.trim() || '任务已完成，但模型没有给出结果。'}`
          const actions = (await database.read()).stores.codeActions.filter(
            (item) => item.runId === result.run.id && item.kind === 'write' && item.status === 'confirmed',
          )
          const artifactPaths = [
            ...new Set(
              actions
                .map((item) =>
                  typeof item.draft.relativePath === 'string' ? item.draft.relativePath : '',
                )
                .filter(Boolean),
            ),
          ]
          return {
            ok: true,
            summary: summary.slice(0, 12_000),
            ...(artifactPaths.length ? { artifactPaths } : {}),
          }
        },
      })
    }
    const document = await database.read()
    const friend = document.stores.friends.find((item) => item.id === task.friendId)
    const provider = document.stores.providers.find((item) => item.id === friend?.providerId)
    if (!friend || !provider) throw new AppError(400, '好友或提供方不在了。')
    const model = friend.defaultModelId || provider.defaultModel
    if (!model) throw new AppError(400, '好友还没有默认模型。')
    const result = await chat({
      baseUrl: provider.baseUrl,
      apiKey: await resolveProviderApiKey(provider, (id) => vault.reveal(id)),
      model,
      messages: [{ role: 'user', content: task.prompt || task.name }],
      signal,
    })
    return result.content || '完成'
  })
  const schedulerEnabled = options.scheduler ?? ui !== 'none'
  if (schedulerEnabled) tasks.startScheduler()
  const ctx: ApiContext = { repos, database, avatars, files, media, turns, vault, mcp, tasks, proposals, assignments, codeActions, plans, clarifies }

  let vite: ViteDevServer | null = null
  const server = createServer((req, res) => {
    void onRequest(req, res, ctx, ui, () => vite)
  })

  if (ui === 'dev') {
    const { createServer: createViteServer } = await import('vite')
    // 先挂上 Vite 再 listen，避免启动窗口里页面请求打到还没准备好的中间件。
    vite = await createViteServer({
      root: projectRoot,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    })
  }

  const port = options.port ?? Number(process.env.PORT ?? 43123)
  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const bound = typeof address === 'object' && address ? address.port : port
  log('info', 'http', '工作台已启动', { host, port: bound, ui, dataFile })

  return {
    port: bound,
    server,
    async close() {
      tasks.stopScheduler()
      turns.dispose()
      await mcp.closeAll()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await vite?.close()
    },
  }
}

async function onRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  ui: 'dev' | 'prod' | 'none',
  getVite: () => ViteDevServer | null,
): Promise<void> {
  try {
    const handled = await handleLocal(req, res, ctx)
    if (handled) return
    if (ui === 'dev') {
      const vite = getVite()
      if (!vite) {
        res.writeHead(503)
        res.end('vite not ready')
        return
      }
      vite.middlewares(req, res, () => {
        if (!res.headersSent) {
          res.statusCode = 404
          res.end('not found')
        }
      })
      return
    }
    if (ui === 'prod') {
      await serveDist(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  } catch (error) {
    log('error', 'http', '未处理的请求错误', {
      error: error instanceof Error ? error.message : String(error),
      path: req.url,
    })
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('服务器出错')
    }
  }
}

async function serveDist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dist = path.join(projectRoot, 'dist')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const resolved = path.resolve(dist, requested)
  const root = path.resolve(dist)
  let file = resolved.startsWith(root + path.sep) || resolved === root ? resolved : ''
  if (file) {
    try {
      const info = await stat(file)
      if (!info.isFile()) file = path.join(dist, 'index.html')
    } catch {
      // 前端是单页，找不到静态文件时退回入口。
      file = path.join(dist, 'index.html')
    }
  } else {
    file = path.join(dist, 'index.html')
  }
  try {
    const body = await readFile(file)
    const ext = path.extname(file)
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.css'
            ? 'text/css; charset=utf-8'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('还没有构建产物，先运行 pnpm build')
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  createHost().catch((error: unknown) => {
    log('error', 'http', '启动失败', { error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
}
