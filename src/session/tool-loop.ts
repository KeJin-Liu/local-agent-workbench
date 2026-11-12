/**
 * 把已连接 MCP 的工具交给模型，执行 tools/call，直到模型给出最终文本。
 * 没有工具时仍走流式补全。轮数有上限，避免工具来回打转。
 */

import type { ChatMessage } from '../llm/client.ts'
import { chat, chatStream } from '../llm/client.ts'
import type { OpenAiTool } from '../mcp/hub.ts'
import { log } from '../logger.ts'

/** 一次发送里最多来回调用工具这么多次，然后强制再要一段文字。 */
export const MAX_TOOL_ROUNDS = 4

export type ToolCallFn = (functionName: string, argsJson: string, signal: AbortSignal) => Promise<string>

export type AssistantTurnResult = {
  content: string
  reasoning?: string
}

export type ToolRoundInput = {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  signal: AbortSignal
  tools: OpenAiTool[]
  callTool: ToolCallFn
  fetchImpl?: typeof fetch
  onProgress?: (state: { content: string; reasoning: string }) => Promise<void>
  conversationId?: string
  runId?: string
  /** 覆盖默认工具往返上限；指派开发任务用更大的轮数。 */
  maxRounds?: number
}

/** 跑完工具循环，返回最终助手文本（及可选 reasoning）。取消会抛 AbortError。 */
export async function runAssistantTurn(input: ToolRoundInput): Promise<AssistantTurnResult> {
  if (input.tools.length === 0) return streamText(input)
  const messages = input.messages.slice()
  let reasoning = ''
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS
  for (let round = 0; round < maxRounds; round += 1) {
    throwIfAborted(input.signal)
    const result = await chat(
      {
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        messages,
        tools: input.tools,
        signal: input.signal,
      },
      input.fetchImpl,
    )
    if (result.reasoning) {
      reasoning = result.reasoning
      await input.onProgress?.({ content: result.content || '', reasoning })
    }
    if (result.toolCalls.length === 0) {
      return {
        content: result.content,
        ...(reasoning || result.reasoning ? { reasoning: reasoning || result.reasoning } : {}),
      }
    }
    const names = result.toolCalls.map((call) => call.name).join('、')
    log('info', 'session', '模型请求工具', {
      conversationId: input.conversationId,
      runId: input.runId,
      round,
      tools: result.toolCalls.length,
    })
    await input.onProgress?.({ content: `正在调用工具：${names}`, reasoning })
    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
    for (const call of result.toolCalls) {
      throwIfAborted(input.signal)
      const text = await input.callTool(call.name, call.arguments, input.signal)
      messages.push({ role: 'tool', content: text, toolCallId: call.id })
    }
  }
  throwIfAborted(input.signal)
  const final = await chat(
    {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: [
        ...messages,
        { role: 'system', content: '请根据已有工具结果，用一段话回答用户。不要再调用工具。' },
      ],
      signal: input.signal,
    },
    input.fetchImpl,
  )
  if (final.reasoning) reasoning = final.reasoning
  return {
    content: final.content,
    ...(reasoning ? { reasoning } : {}),
  }
}

async function streamText(input: ToolRoundInput): Promise<AssistantTurnResult> {
  let content = ''
  let reasoning = ''
  for await (const delta of chatStream(
    {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: input.messages,
      signal: input.signal,
    },
    input.fetchImpl,
  )) {
    throwIfAborted(input.signal)
    if (delta.content) content += delta.content
    if (delta.reasoning) reasoning += delta.reasoning
    await input.onProgress?.({ content, reasoning })
  }
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('aborted')
  error.name = 'AbortError'
  throw error
}
