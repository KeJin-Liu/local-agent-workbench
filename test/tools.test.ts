import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChatMessage } from '../src/llm/client.ts'
import { functionName } from '../src/mcp/hub.ts'
import { MAX_TOOL_ROUNDS, runAssistantTurn } from '../src/session/tool-loop.ts'

describe('MCP 工具循环', () => {
  it('把工具调用执行完，再要最终文字', async () => {
    const calls: string[] = []
    let step = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      step += 1
      void init
      if (step === 1) {
        return json({
          model: 'qwen',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  { id: 'call-1', type: 'function', function: { name: 'mcp_srv__echo', arguments: '{"text":"hi"}' } },
                ],
              },
            },
          ],
        })
      }
      return json({
        model: 'qwen',
        choices: [{ finish_reason: 'stop', message: { content: '最终回答' } }],
      })
    }
    const turn = await runAssistantTurn({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'qwen',
      messages: [{ role: 'user', content: '你好' }],
      signal: new AbortController().signal,
      tools: [{ type: 'function', function: { name: 'mcp_srv__echo', parameters: { type: 'object' } } }],
      callTool: async (name, args) => {
        calls.push(`${name}:${args}`)
        return 'ok'
      },
      fetchImpl,
    })
    assert.equal(turn.content, '最终回答')
    assert.deepEqual(calls, ['mcp_srv__echo:{"text":"hi"}'])
    assert.equal(functionName('abc-def', 'echo'), 'mcp_abc-def__echo')
  })

  it('工具一直要调用时，最多再补一轮文字', async () => {
    let steps = 0
    const fetchImpl: typeof fetch = async () => {
      steps += 1
      if (steps <= MAX_TOOL_ROUNDS) {
        return json({
          model: 'qwen',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [{ id: `c${steps}`, type: 'function', function: { name: 'mcp_a__t', arguments: '{}' } }],
              },
            },
          ],
        })
      }
      return json({
        model: 'qwen',
        choices: [{ finish_reason: 'stop', message: { content: '停下来了' } }],
      })
    }
    const turn = await runAssistantTurn({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'qwen',
      messages: [] as ChatMessage[],
      signal: new AbortController().signal,
      tools: [{ type: 'function', function: { name: 'mcp_a__t', parameters: { type: 'object' } } }],
      callTool: async () => 'ok',
      fetchImpl,
    })
    assert.equal(turn.content, '停下来了')
    assert.equal(steps, MAX_TOOL_ROUNDS + 1)
  })
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
