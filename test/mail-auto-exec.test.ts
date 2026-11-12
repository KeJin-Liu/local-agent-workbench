/**
 * 邮件任务无人值守：写文件 / shell 直接执行，不出确认气泡；额外提示词注入；等回合跑完再收结果。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createCodeActionService } from '../src/app/code-actions.ts'
import { callCodeTool, isCodeToolName } from '../src/app/code-tools.ts'
import { createConversation } from '../src/app/conversations.ts'
import type { Friend } from '../src/domain/types.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('邮件任务无人值守执行', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    await rm(target, { recursive: true, force: true })
  })

  it('autoConfirm 的写文件 / shell 直接执行，不留下待确认卡', async () => {
    const { friend, actions } = await boot()
    const context = { friend, conversationId: 'conv-auto', actions, autoConfirm: true }

    const written = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'note.md', content: 'hello unattended' }),
      context,
    )
    assert.match(written, /已写入/)
    assert.equal((await readFile(path.join(friend.workspacePath!, 'note.md'), 'utf8')), 'hello unattended')
    assert.equal((await actions.listPending('conv-auto')).length, 0)

    const shell = await callCodeTool(
      'workbench_shell',
      JSON.stringify({ command: 'cat note.md' }),
      context,
    )
    assert.match(shell, /退出码：0/)
    assert.match(shell, /hello unattended/)
    assert.equal((await actions.listPending('conv-auto')).length, 0)

    const manual = await callCodeTool(
      'workbench_fs_write',
      JSON.stringify({ path: 'manual.md', content: 'x' }),
      { friend, conversationId: 'conv-manual', actions },
    )
    assert.match(manual, /确认卡/)
    assert.equal((await actions.listPending('conv-manual')).length, 1)
  })

  it('回合按无人值守提示词注入；工具直接落地；waitForRun 拿到最终结果', async () => {
    const { repos, friend, actions } = await boot()
    const conversation = await createConversation(repos, '邮件任务', {
      kind: 'direct',
      friendIds: [friend.id],
    })
    const extraPrompt = '你是无人值守邮件任务。不要反问，不要等确认，直接做完再收口。'
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      codeTools: {
        tools: (await import('../src/app/code-tools.ts')).CODE_TOOLS,
        isBound: () => true,
        call: (name, args, ctx) =>
          isCodeToolName(name) ? callCodeTool(name, args, { ...ctx, actions }) : Promise.resolve('未知工具'),
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
        requests.push(body)
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              model: 'mock-model',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'workbench_fs_write', arguments: JSON.stringify({ path: 'auto.md', content: 'auto' }) },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            model: 'mock-model',
            choices: [{ message: { role: 'assistant', content: '已写入 auto.md，无人值守完成。' } }],
          }),
          { status: 200 },
        )
      },
    })

    try {
      const sent = await turns.sendTurn({
        conversationId: conversation.id,
        text: '写一个 auto.md',
        extraSystemPrompt: extraPrompt,
        autoConfirmCode: true,
      })
      const done = await turns.waitForRun(sent.run.id, { timeoutMs: 5000 })
      assert.equal(done.status, 'done')
      assert.equal(await readFile(path.join(friend.workspacePath!, 'auto.md'), 'utf8'), 'auto')
      assert.equal((await actions.listPending(conversation.id)).length, 0)

      const system = requests[0]?.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n') ?? ''
      assert.match(system, /无人值守邮件任务/)
      assert.match(system, /直接执行并返回结果，不再出确认卡/)
      assert.doesNotMatch(system, /只出示确认卡/)

      const messages = await repos.messages.listByConversation(conversation.id)
      const assistant = messages.find((item) => item.role === 'assistant')
      assert.match(assistant?.content ?? '', /无人值守完成/)
    } finally {
      turns.dispose()
    }
  })

  async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-mail-auto-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const workspace = path.join(directory, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, 'seed.txt'), 'seed', 'utf8')
    const friend: Friend = {
      ...owner,
      defaultModelId: 'mock-model',
      workspacePath: workspace,
      codePermission: 'workspace-write',
    }
    await repos.friends.put(friend)
    return { database, repos, friend, actions: createCodeActionService(database) }
  }
})
