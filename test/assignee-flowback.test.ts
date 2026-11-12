/**
 * p1.5：指派执行按 harness 式开发回流跑工具循环；工具结果回流后继续，最后收口。
 * 覆盖：工具调用 → 工具结果回灌 → 最终文本；进度；步数；DSML 文本收口。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { createAssignmentService } from '../src/app/assignments.ts'
import { createCodeActionService } from '../src/app/code-actions.ts'
import { CODE_TOOLS, callCodeTool, isCodeToolName } from '../src/app/code-tools.ts'
import { canReadCode } from '../src/app/code-workspace.ts'
import { createConversation, updateGroupConversation } from '../src/app/conversations.ts'
import { createAssigneeRunner } from '../src/session/assignee.ts'
import { hasToolMarkup, sanitizeAssignmentText, stripToolMarkup } from '../src/llm/tool-markup.ts'
import type { Assignment, Friend } from '../src/domain/types.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.5 指派执行 · 开发回流', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    await rm(target, { recursive: true, force: true })
  })

  it('识别并收口模型写出的原始工具调用文本', () => {
    const raw = [
      '先看一下工作区结构，再确认改动点。',
      '',
      '< | | DSML | | calls>',
      '< | | DSML | | invoke name="Bash">',
      '< | | DSML | | parameter name="command" string="true">cd /tmp && ls</ | | DSML | | parameter>',
      '</ | | DSML | | invoke>',
      '</ | | DSML | | calls>',
    ].join('\n')
    assert.equal(hasToolMarkup(raw), true)
    assert.equal(stripToolMarkup(raw), '先看一下工作区结构，再确认改动点。')
    assert.match(sanitizeAssignmentText(raw), /^先看一下工作区结构/)
    assert.doesNotMatch(sanitizeAssignmentText(raw), /DSML/)

    const onlyMarkup = '< | | DSML | | calls>< | | DSML | | invoke name="Bash"></ | | DSML | | invoke>'
    assert.match(sanitizeAssignmentText(onlyMarkup), /没有执行/)
    assert.equal(sanitizeAssignmentText('正常收口：改了 A，跑了 B。'), '正常收口：改了 A，跑了 B。')
    assert.equal(hasToolMarkup('普通文本'), false)
  })

  it('带工具时多轮执行：工具结果回流后模型继续，步数和进度可见', async () => {
    const { database, repos, workspace } = await bootWithWorkspace()
    const { owner, dev, group } = await groupWithDev(repos, workspace)
    const assignment: Assignment = {
      id: 'a1',
      conversationId: group.id,
      fromFriendId: owner.id,
      toFriendId: dev.id,
      instruction: '看看工作区里有什么，再给下一步',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const codeActions = createCodeActionService(database)

    const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = []
    const runner = createAssigneeRunner({
      repos,
      codeTools: {
        tools: CODE_TOOLS,
        isBound: canReadCode,
        call: (name, args, ctx) =>
          isCodeToolName(name) ? callCodeTool(name, args, { ...ctx, actions: codeActions }) : Promise.resolve('未知工具'),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>
          tools?: unknown[]
        }
        requests.push(body)
        if (requests.length === 1) {
          assert.ok(body.tools?.some((tool) => JSON.stringify(tool).includes('workbench_fs_list')))
          return chatResponse({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'workbench_fs_list', arguments: JSON.stringify({ path: '.' }) },
              },
            ],
          })
        }
        assert.equal(body.messages.at(-1)?.role, 'tool')
        assert.match(body.messages.at(-1)?.content ?? '', /hello\.txt/)
        return chatResponse({ role: 'assistant', content: '已读完工作区。下一步：改 index.ts 并跑测试。' })
      },
    })

    const progress: string[] = []
    const result = await runner({
      assignment,
      friend: dev,
      conversation: group,
      signal: new AbortController().signal,
      onProgress: async (text) => {
        progress.push(text)
      },
    })

    assert.equal(result.steps, 1)
    assert.match(result.content, /下一步/)
    assert.equal(requests.length, 2)
    assert.ok(progress.some((text) => text.includes('正在调用 workbench_fs_list')))
    assert.ok(progress.some((text) => text.includes('第 1 步')))
  })

  it('指派落库带 steps，完成后清掉 progress；结果卡仍只有 assign/result', async () => {
    const { database, repos } = await boot()
    const { dev, group } = await groupWithDev(repos, '')
    const service = createAssignmentService(database, async ({ onProgress }) => {
      await onProgress?.('正在调用 workbench_fs_read…（第 1 步）')
      await onProgress?.('正在调用 workbench_fs_write…（第 2 步）')
      return { content: '已读文件，下一步改代码。', steps: 2 }
    })
    const assignment = await service.create(group.id, dev.id, '实现 @ 好友')
    const done = await service.settle(assignment.id)

    assert.equal(done.status, 'done')
    assert.equal(done.progress, undefined)
    assert.equal(done.steps, 2)
    const messages = (await repos.messages.listByConversation(group.id)).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
    assert.deepEqual(messages.map((item) => item.kind), ['assign', 'result'])
    const result = messages.find((item) => item.kind === 'result')
    assert.equal(result?.content, '已读文件，下一步改代码。')
    assert.equal(result?.speakerFriendId, dev.id)
  })

  it('指派执行时把这位好友自己的工作目录写进提示词', async () => {
    const { repos } = await boot()
    const { owner, dev, group } = await groupWithDev(repos, '')
    const root = path.join(directory, 'group-root')
    const updated = await updateGroupConversation(repos, group.id, {
      title: group.title,
      friendIds: group.friendIds,
      workspaceRoot: root,
    })
    const devDir = path.join(path.resolve(root), group.title, '代码开发')
    const assignment: Assignment = {
      id: 'a-dir',
      conversationId: updated.id,
      fromFriendId: owner.id,
      toFriendId: dev.id,
      instruction: '请把文件写到 /tmp/别人的目录/稿.html',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    let prompt = ''
    const runner = createAssigneeRunner({
      repos,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        prompt = body.messages.map((item) => item.content).join('\n')
        return chatResponse({ role: 'assistant', content: '只写在自己的目录。' })
      },
    })
    await runner({
      assignment,
      friend: dev,
      conversation: updated,
      signal: new AbortController().signal,
    })
    assert.ok(prompt.includes(`你的工作目录是 ${devDir}`))
    assert.match(prompt, /以这个目录为准，不要写到其他成员的目录/)
    assert.match(prompt, /不要用 \.\./)
    assert.equal(prompt.includes('你的工作目录是 /tmp/别人的目录'), false)
  })

  it('被指派的好友不带本群更早的对话', async () => {
    const { repos } = await boot()
    const { owner, dev, group } = await groupWithDev(repos, '')
    await repos.messages.put({
      id: 'prior-group',
      conversationId: group.id,
      role: 'user',
      content: '昨天约定接口用 REST，不要改成 GraphQL',
      status: 'complete',
      createdAt: Date.now() - 1000,
    })
    const assignment: Assignment = {
      id: 'a-memory',
      conversationId: group.id,
      fromFriendId: owner.id,
      toFriendId: dev.id,
      instruction: '把路由接到群聊',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    let prompt = ''
    const runner = createAssigneeRunner({
      repos,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        prompt = body.messages.map((item) => item.content).join('\n')
        return chatResponse({ role: 'assistant', content: '只按当前任务给出方案。' })
      },
    })
    await runner({
      assignment,
      friend: dev,
      conversation: group,
      signal: new AbortController().signal,
    })
    assert.match(prompt, /没有本群之前的对话/)
    assert.match(prompt, /把路由接到群聊/)
    assert.doesNotMatch(prompt, /GraphQL/)
    assert.doesNotMatch(prompt, /昨天约定接口用 REST/)
  })

  it('模型仍输出 DSML 时二次收口，不把原始标记回流到群里', async () => {
    const { repos } = await boot()
    const { owner, dev, group } = await groupWithDev(repos, '')
    const assignment: Assignment = {
      id: 'a2',
      conversationId: group.id,
      fromFriendId: owner.id,
      toFriendId: dev.id,
      instruction: '看看现有实现',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    let calls = 0
    const runner = createAssigneeRunner({
      repos,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) {
          return chatResponse({
            role: 'assistant',
            content: '先看一下工作区结构。\n< | | DSML | | calls>\n< | | DSML | | invoke name="Bash">',
          })
        }
        return chatResponse({ role: 'assistant', content: '当前没有工作目录，无法读代码；请先绑定目录。' })
      },
    })
    const result = await runner({
      assignment,
      friend: dev,
      conversation: group,
      signal: new AbortController().signal,
    })
    assert.equal(calls, 2)
    assert.equal(result.steps, 0)
    assert.doesNotMatch(result.content, /DSML/)
    assert.match(result.content, /绑定目录/)
  })

  it('指派卡展示进度/步数；历史 DSML 结果展示时也收口', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /assignment\?\.progress/)
    assert.match(pane, /assign-progress/)
    assert.match(pane, /执行 \{assignment\.steps\} 步/)
    assert.match(pane, /sanitizeAssignmentText\(content\)/)
    assert.match(pane, /assignmentRunning\]/)
    assert.match(pane, /还没绑定工作目录/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.assign-progress/)
    assert.match(css, /\.assign-steps/)
  })

  async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-assignee-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    return { database, repos: createRepos(database) }
  }

  async function bootWithWorkspace() {
    const booted = await boot()
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, 'hello.txt'), 'hello', 'utf8')
    return { ...booted, workspace }
  }

  async function groupWithDev(repos: ReturnType<typeof createRepos>, workspace: string) {
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const dev: Friend = {
      ...owner,
      id: 'friend-dev',
      name: '代码开发',
      isOwnerTemplate: false,
      defaultModelId: 'mock-model',
      workspacePath: workspace,
      codePermission: 'read-only',
      providerId: 'ollama-local',
    }
    await repos.friends.put(dev)
    const group = await createConversation(repos, '开发群', {
      kind: 'group',
      friendIds: [owner.id, dev.id],
    })
    return { owner, dev, group }
  }
})

function chatResponse(message: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: 'mock-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...message } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
