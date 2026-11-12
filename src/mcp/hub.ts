/**
 * 用官方 MCP SDK 维持连接。只使用 tools/list 和 tools/call。
 * 资源与提示留到以后。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpConnectionView, McpServer } from '../domain/types.ts'
import { AppError } from '../app/errors.ts'
import { log } from '../logger.ts'

export type OpenAiTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export type ToolCatalog = {
  tools: OpenAiTool[]
  call: (functionName: string, argsJson: string, signal: AbortSignal) => Promise<string>
}

type Session = {
  client: Client
  close: () => Promise<void>
}

const EMPTY: McpConnectionView = { status: 'disconnected', tools: [] }

/** 进程内的 MCP 连接表。配置仍在本地库，连接状态只活在内存里。 */
export function createMcpHub() {
  const sessions = new Map<string, Session>()
  const views = new Map<string, McpConnectionView>()
  const routes = new Map<string, { serverId: string; toolName: string }>()

  function view(id: string): McpConnectionView {
    return views.get(id) ?? EMPTY
  }

  async function connect(server: McpServer, env: Record<string, string>, headers: Record<string, string>): Promise<McpConnectionView> {
    await disconnect(server.id)
    views.set(server.id, { status: 'connecting', tools: [] })
    log('info', 'mcp', '连接', { id: server.id, transport: server.transport })
    try {
      const client = new Client({ name: 'agent-workbench', version: '0.1.0' })
      const transport = createTransport(server, env, headers)
      await client.connect(transport)
      const listed = await client.listTools()
      const tools = listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }))
      sessions.set(server.id, {
        client,
        close: async () => {
          await client.close()
        },
      })
      const next: McpConnectionView = {
        status: 'connected',
        tools: tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
      }
      views.set(server.id, next)
      rememberRoutes(server.id, tools)
      log('info', 'mcp', '已连接', { id: server.id, tools: next.tools.length })
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败'
      const failed: McpConnectionView = { status: 'error', error: message, tools: [] }
      views.set(server.id, failed)
      log('warn', 'mcp', '连接失败', { id: server.id, error: message })
      throw new AppError(400, message)
    }
  }

  async function disconnect(id: string): Promise<McpConnectionView> {
    const session = sessions.get(id)
    sessions.delete(id)
    if (session) {
      await session.close().catch((error: unknown) => {
        log('warn', 'mcp', '断开时出错', {
          id,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    for (const [fn, route] of routes) {
      if (route.serverId === id) routes.delete(fn)
    }
    const next: McpConnectionView = { status: 'disconnected', tools: [] }
    views.set(id, next)
    log('info', 'mcp', '已断开', { id })
    return next
  }

  async function ensureConnected(
    server: McpServer,
    env: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<McpConnectionView> {
    if (sessions.has(server.id) && view(server.id).status === 'connected') return view(server.id)
    return connect(server, env, headers)
  }

  /**
   * 把已启用服务的工具收成 OpenAI function 列表。连不上的服务跳过，不让整次发送失败。
   */
  async function catalogForChat(
    servers: McpServer[],
    resolve: (server: McpServer) => Promise<{ env: Record<string, string>; headers: Record<string, string> }>,
  ): Promise<ToolCatalog> {
    const tools: OpenAiTool[] = []
    for (const server of servers) {
      if (!server.enabled) continue
      try {
        const resolved = await resolve(server)
        await ensureConnected(server, resolved.env, resolved.headers)
        const current = view(server.id)
        for (const tool of current.tools) {
          const fn = functionName(server.id, tool.name)
          routes.set(fn, { serverId: server.id, toolName: tool.name })
          const schema = inputSchema(server.id, tool.name)
          tools.push({
            type: 'function',
            function: {
              name: fn,
              ...(tool.description ? { description: `${server.name}: ${tool.description}` } : { description: server.name }),
              parameters: schema,
            },
          })
        }
      } catch (error) {
        log('warn', 'mcp', '发送时跳过未连上的服务', {
          id: server.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      tools,
      call: (name, argsJson, signal) => callFunction(name, argsJson, signal),
    }
  }

  async function callFunction(functionNameKey: string, argsJson: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError()
    const route = routes.get(functionNameKey)
    if (!route) return `没有这个工具：${functionNameKey}`
    const session = sessions.get(route.serverId)
    if (!session) return `MCP 服务未连接：${route.serverId}`
    let args: Record<string, unknown> = {}
    if (argsJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(argsJson)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '工具参数必须是 JSON 对象。'
        args = parsed as Record<string, unknown>
      } catch {
        return '工具参数不是合法 JSON。'
      }
    }
    log('info', 'mcp', '调用工具', { id: route.serverId, tool: route.toolName })
    try {
      const result = await session.client.callTool({ name: route.toolName, arguments: args }, undefined, { signal })
      return toolResultText(result as { content?: unknown; isError?: boolean; structuredContent?: unknown })
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError()
      const message = error instanceof Error ? error.message : '工具调用失败'
      log('warn', 'mcp', '工具调用失败', { id: route.serverId, tool: route.toolName, error: message })
      return `工具错误：${message}`
    }
  }

  async function closeAll(): Promise<void> {
    const ids = [...sessions.keys()]
    for (const id of ids) await disconnect(id)
  }

  const schemas = new Map<string, Record<string, unknown>>()

  function rememberRoutes(
    serverId: string,
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  ) {
    for (const tool of tools) {
      const fn = functionName(serverId, tool.name)
      routes.set(fn, { serverId, toolName: tool.name })
      schemas.set(fn, tool.inputSchema ?? { type: 'object', properties: {} })
    }
  }

  function inputSchema(serverId: string, toolName: string): Record<string, unknown> {
    return schemas.get(functionName(serverId, toolName)) ?? { type: 'object', properties: {} }
  }

  return { view, connect, disconnect, ensureConnected, catalogForChat, closeAll }
}

export type McpHub = ReturnType<typeof createMcpHub>

function createTransport(server: McpServer, env: Record<string, string>, headers: Record<string, string>) {
  if (server.transport === 'stdio') {
    const command = server.command?.trim()
    if (!command) throw new AppError(400, 'stdio 服务需要命令。')
    return new StdioClientTransport({
      command,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...env },
      stderr: 'pipe',
    })
  }
  const url = server.url?.trim()
  if (!url) throw new AppError(400, '这个传输方式需要 URL。')
  const requestInit = { headers }
  if (server.transport === 'sse') return new SSEClientTransport(new URL(url), { requestInit })
  return new StreamableHTTPClientTransport(new URL(url), { requestInit })
}

/** OpenAI function 名只允许字母数字和 _-。 */
export function functionName(serverId: string, toolName: string): string {
  const server = serverId.replace(/[^a-zA-Z0-9_-]/g, '')
  const tool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp_${server}__${tool}`
}

function toolResultText(result: { content?: unknown; isError?: boolean; structuredContent?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : []
  const texts = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || !('type' in part)) return []
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') return [part.text]
    return []
  })
  const text = texts.join('\n') || JSON.stringify(result.structuredContent ?? {}).slice(0, 4000)
  return result.isError ? `工具错误：${text}` : text.slice(0, 8000)
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
