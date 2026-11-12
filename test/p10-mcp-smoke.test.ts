/**
 * p1.0：真 MCP tools 一次调用（离线）。spawn 仓库内 echo server，经 hub list→call。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createMcpHub, functionName } from '../src/mcp/hub.ts'
import type { McpServer } from '../src/domain/types.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const echoScript = path.join(root, 'scripts', 'mcp-echo-server.mjs')

describe('p1.0 MCP 真 tools 冒烟', () => {
  it('stdio echo：连接后 catalog 含工具，callTool 返回 echo 文本', async () => {
    const hub = createMcpHub()
    const server: McpServer = {
      id: 'echo-smoke',
      name: 'echo-smoke',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [echoScript],
      env: [],
      headers: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    try {
      const view = await hub.connect(server, {}, {})
      assert.equal(view.status, 'connected')
      assert.ok(view.tools.some((tool) => tool.name === 'echo'))

      const catalog = await hub.catalogForChat([server], async () => ({ env: {}, headers: {} }))
      const fn = functionName(server.id, 'echo')
      assert.ok(catalog.tools.some((tool) => tool.function.name === fn))

      const text = await catalog.call(fn, JSON.stringify({ text: 'p10' }), new AbortController().signal)
      assert.equal(text, 'echo:p10')
    } finally {
      await hub.closeAll()
    }
  })
})
