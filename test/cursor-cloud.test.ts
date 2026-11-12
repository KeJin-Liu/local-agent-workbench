import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chat, chatStream } from '../src/llm/client.ts'
import { LlmError } from '../src/llm/errors.ts'
import { humanizeTurnError } from '../src/session/orchestrator.ts'

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('Cursor 云端对话', () => {
  it('不请求 /chat/completions，收齐增量并删掉这次智能体', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (method === 'POST' && url.endsWith('/v1/agents')) {
        const body = JSON.parse(String(init?.body)) as { model: { id: string } }
        assert.equal(body.model.id, 'grok-4.7')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer crsr_test')
        return new Response(JSON.stringify({ agent: { id: 'bc-1' }, run: { id: 'run-1' } }), { status: 200 })
      }
      if (method === 'GET' && url.endsWith('/stream')) {
        return new Response(
          sseBody([
            'event: assistant\ndata: {"text":"你"}\n\n',
            'event: thinking\ndata: {"text":"想"}\n\n',
            'event: result\ndata: {"status":"FINISHED","text":"你好"}\n\n',
            'event: done\ndata: {}\n\n',
          ]),
          { status: 200 },
        )
      }
      if (method === 'DELETE') return new Response(null, { status: 200 })
      return new Response('no', { status: 500 })
    }
    const result = await chat(
      {
        baseUrl: 'https://api.cursor.com/v1',
        apiKey: 'crsr_test',
        model: 'grok-4.7',
        messages: [{ role: 'user', content: '在吗' }],
      },
      fetchImpl,
    )
    assert.equal(result.content, '你好')
    assert.equal(result.reasoning, '想')
    assert.deepEqual(result.toolCalls, [])
    assert.equal(calls.some((item) => item.includes('/chat/completions')), false)
    assert.equal(calls.at(-1), 'DELETE https://api.cursor.com/v1/agents/bc-1')
  })

  it('流式只吐出新增的正文', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body)) as { model: { id: string; params?: unknown } }
        assert.equal(body.model.id, 'auto-smart')
        assert.deepEqual(body.model.params, [{ id: 'optimize_for', value: 'balanced' }])
        return new Response(JSON.stringify({ agent: { id: 'bc-2' }, run: { id: 'run-2' } }), { status: 200 })
      }
      if (url.endsWith('/stream')) {
        return new Response(sseBody(['event: result\ndata: {"status":"FINISHED","text":"好"}\n\n']), { status: 200 })
      }
      return new Response(null, { status: 200 })
    }
    let text = ''
    for await (const delta of chatStream(
      {
        baseUrl: 'https://api.cursor.com/v1/',
        apiKey: 'crsr_test',
        model: 'auto-smart',
        messages: [{ role: 'user', content: '在吗' }],
      },
      fetchImpl,
    )) {
      text += delta.content ?? ''
    }
    assert.equal(text, '好')
  })

  it('创建失败时给出 Cloud Agent 提示，而不是 /v1 结尾那句', async () => {
    const fetchImpl: typeof fetch = async () => new Response('missing', { status: 404 })
    const error = await chat(
      {
        baseUrl: 'https://api.cursor.com/v1',
        apiKey: 'crsr_test',
        model: 'grok-4.7',
        messages: [{ role: 'user', content: '在吗' }],
      },
      fetchImpl,
    ).then(
      () => null,
      (cause: unknown) => cause,
    )
    assert.ok(error instanceof LlmError)
    assert.match(humanizeTurnError(error), /Cloud Agent/)
  })
})
