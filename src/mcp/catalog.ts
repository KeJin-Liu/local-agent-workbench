/**
 * 本地 MCP 市场目录。演示用内置条目；启用后写入 mcpServers，非云商店。
 */

import type { McpPrompt, McpResource, McpTransport } from '../domain/types.ts'

export type CatalogTemplate = {
  id: string
  name: string
  summary: string
  transport: McpTransport
  toolCount: number
  icon: string
  command?: string
  args?: string[]
  url?: string
  resources: McpResource[]
  prompts: McpPrompt[]
}

const FS_RESOURCES: McpResource[] = [
  {
    uri: 'file:///workspace',
    name: '工作区根目录',
    mime: 'inode/directory',
    description: '当前项目工作区；可读目录树与文件。',
    textPreview: 'uri: file:///workspace\nmime: inode/directory\n\nentries:\n  - package.json\n  - README.md\n  - src/',
  },
  {
    uri: 'file:///workspace/package.json',
    name: 'package.json',
    mime: 'application/json',
    description: '根目录依赖清单。',
    textPreview: '{\n  "name": "local-agent-workbench",\n  "private": true,\n  "version": "0.5.0"\n}',
  },
  {
    uri: 'file:///workspace/README.md',
    name: 'README.md',
    mime: 'text/markdown',
    description: '项目说明与启动方式。',
    textPreview: '# 本地智能体工作台\n\n数据全本地。UI 包见 agent-chat-ui/。',
  },
]

const FS_PROMPTS: McpPrompt[] = [
  {
    name: '代码审阅',
    description: '按清单审阅变更：正确性、边界、回归。',
    arguments: [{ name: 'path', description: '要审阅的路径', required: true }],
    template: '请审阅 {{path}}：正确性、边界条件、回归风险。给出可执行修改建议。',
  },
  {
    name: '目录摘要',
    description: '概括目录用途与关键文件。',
    arguments: [{ name: 'dir', description: '目录路径' }],
    template: '请用 5 条以内概括目录 {{dir}} 的用途与关键文件。',
  },
]

export const MCP_CATALOG: CatalogTemplate[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    summary: '读写本地工作区文件与目录；适合代码与文档助手。',
    transport: 'stdio',
    toolCount: 6,
    icon: '📁',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    resources: FS_RESOURCES,
    prompts: FS_PROMPTS,
  },
  {
    id: 'browser-tools',
    name: 'browser-tools',
    summary: '控制本机浏览器标签、截图与控制台；调试前端。',
    transport: 'sse',
    toolCount: 8,
    icon: '🌐',
    url: 'http://127.0.0.1:3025/sse',
    resources: [
      {
        uri: 'browser://tabs',
        name: '打开的标签',
        description: '当前浏览器标签列表（演示）。',
        textPreview: 'tabs:\n  - localhost:5173\n  - about:blank',
      },
    ],
    prompts: [
      {
        name: '截图对比',
        description: '对比两个页面截图差异。',
        template: '请对比当前页与参考页的视觉差异，列出布局与文案问题。',
      },
    ],
  },
  {
    id: 'github',
    name: 'github',
    summary: '仓库、Issue、PR 与 Actions；密钥走密码库。',
    transport: 'stdio',
    toolCount: 12,
    icon: '🐙',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    resources: [],
    prompts: [
      {
        name: '写 PR 描述',
        description: '根据 diff 起草 PR 说明。',
        template: '根据当前变更起草 PR 标题与正文（中文）。',
      },
    ],
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    summary: '查询与维护本地 SQLite；只读或受控写入。',
    transport: 'stdio',
    toolCount: 5,
    icon: '🗄️',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data/demo.db'],
    resources: [],
    prompts: [],
  },
  {
    id: 'fetch',
    name: 'fetch',
    summary: '抓取公网 URL 文本/HTML；适合资料汇总。',
    transport: 'stdio',
    toolCount: 3,
    icon: '🔗',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    resources: [],
    prompts: [],
  },
  {
    id: 'memory',
    name: 'memory',
    summary: '本地知识图谱式记忆读写；与好友长期记忆互补。',
    transport: 'stdio',
    toolCount: 4,
    icon: '🧠',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    resources: [],
    prompts: [],
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    summary: '无头浏览器自动化导航与抽取；偏批处理。',
    transport: 'stdio',
    toolCount: 7,
    icon: '🎭',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    resources: [],
    prompts: [],
  },
  {
    id: 'time',
    name: 'time',
    summary: '时区换算与当前时间；调度任务辅助。',
    transport: 'stdio',
    toolCount: 2,
    icon: '⏰',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    resources: [],
    prompts: [],
  },
]

export function findCatalogTemplate(id: string): CatalogTemplate | undefined {
  return MCP_CATALOG.find((item) => item.id === id)
}

export function searchCatalog(query: string): CatalogTemplate[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...MCP_CATALOG]
  return MCP_CATALOG.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.summary.toLowerCase().includes(q) ||
      item.transport.includes(q),
  )
}
