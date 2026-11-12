/**
 * 端到端：邮件工作指令按设置里的提示词无人值守执行，写文件直接落地，
 * 等模型收口后再用 SMTP 回真实结果；没有待确认气泡。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MAIL_POLL_TASK_ID } from '../src/domain/mail-constants.ts'
import { createHost } from '../src/server.ts'

describe('邮件无人值守端到端', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop()
      if (close) await close()
    }
  })

  it('设置里的提示词生效；写文件不弹确认；收口后 SMTP 回真实结果', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wb-mail-unattended-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace, { recursive: true })

    const modelRequests: Array<{ system: string; user: string }> = []
    const model = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }
      const system = body.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
      const user = [...body.messages].reverse().find((item) => item.role === 'user')?.content ?? ''
      modelRequests.push({ system, user })
      const message =
        modelRequests.length === 1
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'workbench_fs_write',
                    arguments: JSON.stringify({ path: 'done.md', content: 'mail done' }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: '已完成：写了 done.md，内容 mail done；已验证文件存在。' }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message }] }))
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', () => resolve()))
    const modelAddress = model.address()
    const modelPort = typeof modelAddress === 'object' && modelAddress ? modelAddress.port : 0
    cleanup.push(async () => new Promise<void>((resolve) => model.close(() => resolve())))

    const smtp: Array<{ to: string; subject: string; body: string }> = []
    const host = await createHost({
      dataFile: path.join(directory, 'agent_workbench.json'),
      uploadDir: path.join(directory, 'avatars'),
      mediaDir: path.join(directory, 'media'),
      port: 0,
      host: '127.0.0.1',
      ui: 'none',
      sendDelayMs: 0,
      scheduler: false,
      mailTransport: {
        fetchInbox: async () => [
          {
            id: 'mail-1',
            from: 'boss@example.com',
            subject: '写一个文件',
            body: '在 workspace 写 done.md，内容 mail done。',
          },
        ],
        sendSmtp: async (input) => {
          smtp.push({ to: input.to, subject: input.subject, body: input.body })
        },
      },
    })
    cleanup.push(() => host.close())
    const base = `http://127.0.0.1:${host.port}`

    const workbench = await (await fetch(`${base}/api/workbench`)).json()
    const owner = workbench.friends.find((item: { isOwnerTemplate: boolean }) => item.isOwnerTemplate)
    const ownerConversation = workbench.conversations.find(
      (item: { kind: string; friendIds: string[] }) =>
        item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === owner.id,
    )
    assert.ok(ownerConversation?.id)

    await fetch(`${base}/api/providers/ollama-local`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ollama 本地',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        enabled: true,
        defaultModel: 'mock-model',
      }),
    })
    await fetch(`${base}/api/friends/${encodeURIComponent(owner.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: owner.name,
        description: owner.description,
        systemPrompt: owner.systemPrompt,
        avatar: owner.avatar,
        providerId: owner.providerId,
        defaultModelId: 'mock-model',
        workspacePath: workspace,
        codePermission: 'workspace-write',
      }),
    })
    const customPrompt = 'CUSTOM_MAIL_PROMPT：无人值守，直接做完，不要反问。'
    const settings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mailInstructions: {
          enabled: true,
          whitelist: ['boss@example.com'],
          pollIntervalMinutes: 10,
          taskPrompt: customPrompt,
          autoConfirm: true,
          imap: { host: 'imap.example.com', port: 993, tls: true, username: 'bot@example.com', vaultEntryId: 'imap-secret' },
          smtp: { host: 'smtp.example.com', port: 465, tls: true, username: 'bot@example.com', vaultEntryId: 'smtp-secret' },
        },
      }),
    })
    assert.equal(settings.status, 200)

    const runResponse = await fetch(`${base}/api/tasks/${encodeURIComponent(MAIL_POLL_TASK_ID)}/run`, {
      method: 'POST',
    })
    const runBody = await runResponse.json()
    assert.equal(runResponse.status, 200, JSON.stringify(runBody))
    assert.equal(runBody.task.lastStatus, 'success')
    assert.match(runBody.task.history[0].result, /拉取 1 封，执行 1/)

    assert.equal(await readFile(path.join(workspace, 'done.md'), 'utf8'), 'mail done')
    assert.equal(smtp.length, 1)
    assert.equal(smtp[0]?.to, 'boss@example.com')
    assert.match(smtp[0]?.body ?? '', /工作指令执行成功/)
    assert.match(smtp[0]?.body ?? '', /已完成：写了 done\.md/)
    assert.match(smtp[0]?.body ?? '', /done\.md/)

    const pending = await (
      await fetch(`${base}/api/conversations/${encodeURIComponent(ownerConversation.id)}/code-actions`)
    ).json()
    assert.deepEqual(pending.actions, [])

    const first = modelRequests[0]
    assert.ok(first)
    assert.match(first.system, /CUSTOM_MAIL_PROMPT/)
    assert.match(first.system, /无人值守任务/)
    assert.match(first.system, /直接执行并返回结果，不再出确认卡/)
    assert.doesNotMatch(first.system, /只出示确认卡/)
    assert.match(first.user, /【邮件工作指令】/)
  })
})
