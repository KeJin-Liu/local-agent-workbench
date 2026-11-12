/**
 * 离线联调用的最小 MCP stdio 服务：只提供 tools/echo。
 * 用法：node scripts/mcp-echo-server.mjs
 * 工作台里建 stdio 服务：command=node，args=[本文件绝对路径]
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'workbench-echo', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the text argument. For local smoke tests.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo' },
        },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments ?? {}
  if (name !== 'echo') {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
  const text = typeof args.text === 'string' ? args.text : JSON.stringify(args)
  return { content: [{ type: 'text', text: `echo:${text}` }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
