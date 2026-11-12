/**
 * 视觉插件：好友开启后，有图片的回合切到视觉模型并内联 image_url；没开则仍走文本标签。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { createConversation } from '../src/app/conversations.ts'
import type { Friend, MessageAttachment } from '../src/domain/types.ts'
import { createOrchestrator } from '../src/session/orchestrator.ts'
import { openDatabase } from '../src/storage/database.ts'
import { createRepos } from '../src/storage/repos/index.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const encoder = new TextEncoder()

const image: MessageAttachment = {
  id: 'img-1',
  kind: 'image',
  name: 'red.png',
  mime: 'image/png',
  size: 3,
  path: '/media/files/img-1.png',
}

describe('视觉插件', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    await rm(target, { recursive: true, force: true })
  })

  it('开启且有图片：切视觉模型，图片以 image_url 内联；关闭则用文本标签', async () => {
    const { repos, friend, conversation } = await boot()
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      loadImage: async (attachment) =>
        attachment.id === image.id ? { mime: 'image/png', data: Uint8Array.from([1, 2, 3]) } : null,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> })
        return sse('我看到了红色图片')
      },
    })

    try {
      const sent = await turns.sendTurn({
        conversationId: conversation.id,
        text: '这是什么？',
        attachments: [image],
      })
      await turns.waitForRun(sent.run.id, { timeoutMs: 5000 })
      const run = await repos.runs.get(sent.run.id)
      assert.equal(run?.vision, true)
      assert.equal(run?.model, 'vision-model')
      assert.equal(run?.providerId, 'ollama-local')

      const user = [...(requests[0]?.messages ?? [])].reverse().find((item) => item.role === 'user')
      assert.ok(Array.isArray(user?.content))
      const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
      assert.equal(parts[0]?.type, 'text')
      assert.match(parts[0]?.text ?? '', /\[图片: red\.png\]/)
      const imagePart = parts.find((item) => item.type === 'image_url')
      assert.match(imagePart?.image_url?.url ?? '', /^data:image\/png;base64,AQID$/)

      // 关闭视觉插件后同一张图不再内联，模型回到默认文本模型
      await repos.friends.put({ ...friend, vision: { enabled: false } })
      const plain = await turns.sendTurn({
        conversationId: conversation.id,
        text: '再看一次',
        attachments: [image],
      })
      await turns.waitForRun(plain.run.id, { timeoutMs: 5000 })
      const plainRun = await repos.runs.get(plain.run.id)
      assert.equal(plainRun?.vision, undefined)
      assert.equal(plainRun?.model, 'text-model')
      const plainUser = [...(requests.at(-1)?.messages ?? [])].reverse().find((item) => item.role === 'user')
      assert.equal(typeof plainUser?.content, 'string')
      assert.match(String(plainUser?.content), /\[图片: red\.png\]/)
    } finally {
      turns.dispose()
    }
  })

  it('最近消息有图片且视觉提供方可用：文本跟进仍切视觉模型', async () => {
    const { repos, conversation } = await boot()
    await repos.messages.put({
      id: 'old-image',
      conversationId: conversation.id,
      role: 'user',
      content: '以前的截图',
      status: 'complete',
      attachments: [image],
      createdAt: Date.now() - 60_000,
    })
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse('看到了'),
    })
    try {
      const sent = await turns.sendTurn({ conversationId: conversation.id, text: '图里写了什么' })
      const run = await repos.runs.get(sent.run.id)
      assert.equal(run?.vision, true)
      assert.equal(run?.providerId, 'ollama-local')
      assert.equal(run?.model, 'vision-model')
    } finally {
      turns.dispose()
    }
  })

  it('视觉提供方已停用、本条没有新图：退回好友的聊天模型', async () => {
    const { repos, friend, conversation } = await boot()
    await repos.friends.put({
      ...friend,
      providerId: 'ollama-local',
      defaultModelId: 'text-model',
      vision: { enabled: true, providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    await repos.messages.put({
      id: 'old-image',
      conversationId: conversation.id,
      role: 'user',
      content: '以前的截图',
      status: 'complete',
      attachments: [image],
      createdAt: Date.now() - 60_000,
    })
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse('好的'),
    })
    try {
      const sent = await turns.sendTurn({ conversationId: conversation.id, text: '处理邮件指令' })
      const run = await repos.runs.get(sent.run.id)
      assert.equal(run?.vision, undefined)
      assert.equal(run?.providerId, 'ollama-local')
      assert.equal(run?.model, 'text-model')
    } finally {
      turns.dispose()
    }
  })

  it('邮件任务跳过视觉：旧图片不把回合改到视觉模型', async () => {
    const { repos, conversation } = await boot()
    await repos.messages.put({
      id: 'old-image',
      conversationId: conversation.id,
      role: 'user',
      content: '以前的截图',
      status: 'complete',
      attachments: [image],
      createdAt: Date.now() - 60_000,
    })
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse('已处理'),
    })
    try {
      const sent = await turns.sendTurn({
        conversationId: conversation.id,
        text: '【邮件工作指令】',
        skipVision: true,
      })
      const run = await repos.runs.get(sent.run.id)
      assert.equal(run?.vision, undefined)
      assert.equal(run?.providerId, 'ollama-local')
      assert.equal(run?.model, 'text-model')
    } finally {
      turns.dispose()
    }
  })

  it('本条带了图片且视觉提供方已停用：仍要求先启用', async () => {
    const { repos, friend, conversation } = await boot()
    await repos.friends.put({
      ...friend,
      vision: { enabled: true, providerId: 'deepseek', modelId: 'deepseek-flash' },
    })
    const turns = createOrchestrator({
      repos,
      delayMs: 0,
      fetchImpl: async () => sse('不会走到'),
    })
    try {
      await assert.rejects(
        () =>
          turns.sendTurn({
            conversationId: conversation.id,
            text: '看这张图',
            attachments: [image],
          }),
        /DeepSeek 已停用/,
      )
    } finally {
      turns.dispose()
    }
  })

  it('好友设置里有视觉插件入口', async () => {
    const panel = await readFile(path.join(root, 'src/ui/friend-panel.tsx'), 'utf8')
    assert.match(panel, /视觉插件/)
    assert.match(panel, /识别会话图片/)
    assert.match(panel, /visionEnabled/)
    assert.match(panel, /visionModelId/)
    assert.match(panel, /视觉插件没有写入本地库/)
  })

  async function boot() {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-vision-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const repos = createRepos(database)
    const owner = (await repos.friends.list()).find((item) => item.isOwnerTemplate)
    assert.ok(owner)
    const friend: Friend = {
      ...owner,
      defaultModelId: 'text-model',
      vision: { enabled: true, providerId: 'ollama-local', modelId: 'vision-model' },
    }
    await repos.friends.put(friend)
    const conversation = await createConversation(repos, '视觉测试', {
      kind: 'direct',
      friendIds: [friend.id],
    })
    return { repos, friend, conversation }
  }
})

function sse(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const payload = JSON.stringify({ choices: [{ delta: { content: text } }] })
        controller.enqueue(encoder.encode(`data: ${payload}\n\ndata: [DONE]\n`))
        controller.close()
      },
    }),
    { status: 200 },
  )
}
