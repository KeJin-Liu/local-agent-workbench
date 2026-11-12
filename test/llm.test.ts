import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chat, chatStream, joinOpenAiUrl, listModels } from '../src/llm/client.ts'
import { LlmError } from '../src/llm/errors.ts'
import { probeEndpoint } from '../src/app/providers.ts'

describe('OpenAI 兼容客户端', () => {
  it('请求 /models 并读出 data', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:11434/v1/models')
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b', owned_by: 'ollama' }, { id: '' }] }), {
        status: 200,
      })
    }
    const models = await listModels({ baseUrl: 'http://127.0.0.1:11434/v1/' }, fetchImpl)
    assert.deepEqual(models, [{ id: 'qwen2.5:7b', ownedBy: 'ollama' }])
    assert.equal(joinOpenAiUrl('http://127.0.0.1:1234/v1/', '/models'), 'http://127.0.0.1:1234/v1/models')
  })

  it('读取 Cursor GET /v1/models 的 items', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.cursor.com/v1/models')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer crsr_test')
      return new Response(
        JSON.stringify({
          items: [
            { id: 'composer-2.5', displayName: 'Composer 2.5' },
            { id: 'grok-4.7', displayName: 'Grok 4.7' },
            { displayName: '缺 id' },
          ],
        }),
        { status: 200 },
      )
    }
    const models = await listModels({ baseUrl: 'https://api.cursor.com/v1', apiKey: 'crsr_test' }, fetchImpl)
    assert.deepEqual(models, [{ id: 'composer-2.5' }, { id: 'grok-4.7' }])
  })

  it('连不上时给出可执行的人话提示', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(
      listModels({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'secret' }, fetchImpl),
      (error: unknown) => error instanceof LlmError && error.code === 'network' && (error.hint ?? '').includes('本机模型服务'),
    )
    await assert.rejects(probeEndpoint({ baseUrl: 'file:///tmp/models' }), /http/)
  })

  it('解释 404，并拼出流式文本', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : null
      if (!body) return new Response('missing', { status: 404 })
      if (!body.stream) {
        return new Response(JSON.stringify({ model: 'qwen', choices: [{ finish_reason: 'stop', message: { content: '你好' } }] }), {
          status: 200,
        })
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }
    await assert.rejects(listModels({ baseUrl: 'http://127.0.0.1:11434' }, fetchImpl), LlmError)
    const completion = await chat(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', messages: [{ role: 'user', content: '在吗' }] },
      fetchImpl,
    )
    assert.equal(completion.content, '你好')
    let text = ''
    for await (const delta of chatStream(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', messages: [{ role: 'user', content: '在吗' }] },
      fetchImpl,
    )) {
      text += delta.content ?? ''
    }
    assert.equal(text, '你好')
  })

  it('流式/非流式归一 reasoning_content', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : null
      if (!body?.stream) {
        return new Response(
          JSON.stringify({
            model: 'deepseek-reasoner',
            choices: [{ finish_reason: 'stop', message: { content: '答案', reasoning_content: '先想一步' } }],
          }),
          { status: 200 },
        )
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning":"法"}}]}\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"答"}}]}\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"案"}}]}\n\ndata: [DONE]\n'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }
    const completion = await chat(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'deepseek-reasoner', messages: [{ role: 'user', content: '问' }] },
      fetchImpl,
    )
    assert.equal(completion.content, '答案')
    assert.equal(completion.reasoning, '先想一步')
    let content = ''
    let reasoning = ''
    for await (const delta of chatStream(
      { baseUrl: 'http://127.0.0.1:11434/v1', model: 'deepseek-reasoner', messages: [{ role: 'user', content: '问' }] },
      fetchImpl,
    )) {
      content += delta.content ?? ''
      reasoning += delta.reasoning ?? ''
    }
    assert.equal(content, '答案')
    assert.equal(reasoning, '想法')
  })
})
