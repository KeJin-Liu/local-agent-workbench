/**
 * MCP 配置和连接。工具预览、连接状态都从这里出去；明文环境变量不进日志。
 */

import type {
  Conversation,
  McpCatalogEntry,
  McpEnvBinding,
  McpPrompt,
  McpResource,
  McpScope,
  McpServer,
  McpServerView,
  McpToolPreview,
  McpTransport,
} from '../domain/types.ts'
import { findCatalogTemplate, searchCatalog } from '../mcp/catalog.ts'
import { createMcpHub, type McpHub, type ToolCatalog } from '../mcp/hub.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import type { RevealedSecret } from '../vault/service.ts'
import { AppError } from './errors.ts'

export type McpDraft = {
  id?: string
  name: string
  enabled?: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: McpEnvBinding[]
  headers?: McpEnvBinding[]
  scope?: McpScope
  friendIds?: string[]
  groupIds?: string[]
  catalogId?: string
}

/** 这一回合该把哪些 MCP 带进模型。发言人用来判断好友作用域。 */
export type McpChatTarget = {
  kind: Conversation['kind']
  speakerFriendId?: string
  /** 群用 lineageId；没有 lineage 时用会话 id。 */
  lineageId?: string
}

/**
 * 缺省 scope 视为全局，避免旧配置突然从所有会话消失。
 * 指定好友只在该好友发言时出现；指定群只在这个群的对话里出现。
 */
export function mcpAppliesToChat(
  server: Pick<McpServer, 'scope' | 'friendIds' | 'groupIds'>,
  target: McpChatTarget,
): boolean {
  const scope = server.scope ?? 'global'
  if (scope === 'global') return true
  if (scope === 'friends') return Boolean(target.speakerFriendId && server.friendIds?.includes(target.speakerFriendId))
  if (scope === 'groups') {
    return target.kind === 'group' && Boolean(target.lineageId && server.groupIds?.includes(target.lineageId))
  }
  return false
}

/** 客户端可能传某一段的会话 id，落库时收成群 lineage。找不到则不是群。 */
export function resolveGroupLineage(
  conversations: Array<Pick<Conversation, 'id' | 'kind' | 'lineageId'>>,
  id: string,
): string | undefined {
  const hit = conversations.find((item) => item.kind === 'group' && (item.id === id || item.lineageId === id))
  if (!hit) return undefined
  return hit.lineageId || hit.id
}

export function createMcpService(
  database: WorkbenchDatabase,
  reveal: (secretId: string) => Promise<RevealedSecret | undefined>,
) {
  const hub = createMcpHub()

  async function read(id: string): Promise<McpServer> {
    const server = (await database.read()).stores.mcpServers.find((item) => item.id === id)
    if (!server) throw new AppError(404, '找不到这个 MCP 服务')
    return normalize(server)
  }

  async function materialize(server: McpServer): Promise<{ env: Record<string, string>; headers: Record<string, string> }> {
    return {
      env: await bindingsToRecord(server.env, reveal),
      headers: await bindingsToRecord(server.headers ?? [], reveal),
    }
  }

  return {
    hub: hub satisfies McpHub,

    async list(): Promise<McpServerView[]> {
      const document = await database.read()
      return document.stores.mcpServers
        .map(normalize)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .map((server) => ({ ...server, connection: hub.view(server.id) }))
    },

    async upsert(draft: McpDraft): Promise<McpServer> {
      const name = draft.name.trim()
      if (!name) throw new AppError(400, 'MCP 名称不能为空。')
      if (draft.transport !== 'stdio' && draft.transport !== 'sse' && draft.transport !== 'http') {
        throw new AppError(400, '传输方式不正确。')
      }
      const now = Date.now()
      const existing = draft.id
        ? (await database.read()).stores.mcpServers.map(normalize).find((item) => item.id === draft.id)
        : undefined
      const scope = draft.scope ?? existing?.scope
      let friendIds =
        draft.friendIds !== undefined
          ? [...new Set(draft.friendIds.map((item) => item.trim()).filter(Boolean))]
          : existing?.friendIds
      let groupIds =
        draft.groupIds !== undefined
          ? [...new Set(draft.groupIds.map((item) => item.trim()).filter(Boolean))]
          : existing?.groupIds
      if (scope === 'global') {
        friendIds = undefined
        groupIds = undefined
      } else if (scope === 'friends') {
        groupIds = undefined
      } else if (scope === 'groups') {
        friendIds = undefined
        const conversations = (await database.read()).stores.conversations
        const resolved = [...new Set((groupIds ?? []).map((id) => resolveGroupLineage(conversations, id)).filter((id): id is string => Boolean(id)))]
        if ((groupIds ?? []).length === 0 || resolved.length !== (groupIds ?? []).length) {
          throw new AppError(400, (groupIds ?? []).length === 0 ? '指定群聊时至少选一个。' : '指定的群不存在。')
        }
        groupIds = resolved
      }
      const catalogId = draft.catalogId ?? existing?.catalogId
      const server: McpServer = {
        id: existing?.id ?? draft.id ?? crypto.randomUUID(),
        name,
        enabled: draft.enabled ?? existing?.enabled ?? false,
        transport: draft.transport,
        env: sanitizeEnv(draft.env ?? existing?.env ?? []),
        headers: sanitizeEnv(draft.headers ?? existing?.headers ?? []),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(draft.command?.trim() || existing?.command ? { command: (draft.command?.trim() || existing?.command) as string } : {}),
        ...(draft.args
          ? { args: draft.args.map((item) => item.trim()).filter(Boolean) }
          : existing?.args
            ? { args: existing.args }
            : {}),
        ...(draft.url?.trim() || existing?.url ? { url: (draft.url?.trim() || existing?.url) as string } : {}),
        ...(scope ? { scope } : {}),
        ...(friendIds && friendIds.length ? { friendIds } : {}),
        ...(groupIds && groupIds.length ? { groupIds } : {}),
        ...(catalogId ? { catalogId } : {}),
      }
      if (server.transport === 'stdio' && !server.command) throw new AppError(400, 'stdio 服务需要命令。')
      if (server.transport !== 'stdio' && !server.url) throw new AppError(400, 'sse / http 服务需要 URL。')
      await database.update((document) => {
        const index = document.stores.mcpServers.findIndex((item) => item.id === server.id)
        if (index === -1) document.stores.mcpServers.push(server)
        else document.stores.mcpServers[index] = server
      })
      log('info', 'mcp', existing ? '更新服务' : '新建服务', {
        id: server.id,
        transport: server.transport,
        enabled: server.enabled,
      })
      return server
    },

    async remove(id: string): Promise<void> {
      await hub.disconnect(id)
      await database.update((document) => {
        document.stores.mcpServers = document.stores.mcpServers.filter((item) => item.id !== id)
      })
      log('info', 'mcp', '删除服务', { id })
    },

    async connect(id: string): Promise<McpServerView> {
      const server = await read(id)
      const resolved = await materialize(server)
      await hub.connect(server, resolved.env, resolved.headers)
      return { ...server, connection: hub.view(id) }
    },

    async disconnect(id: string): Promise<McpServerView> {
      const server = await read(id)
      await hub.disconnect(id)
      return { ...server, connection: hub.view(id) }
    },

    async preview(id: string): Promise<McpToolPreview[]> {
      const view = await this.connect(id)
      log('info', 'mcp', '工具预览完成', { id, count: view.connection.tools.length })
      return view.connection.tools
    },


    async listCatalog(query = ''): Promise<McpCatalogEntry[]> {
      const servers = (await database.read()).stores.mcpServers.map(normalize)
      return searchCatalog(query).map((item) => {
        const matched =
          servers.find((server) => server.catalogId === item.id || server.id === item.id) ??
          servers.find((server) => server.name === item.name)
        return {
          id: item.id,
          name: item.name,
          summary: item.summary,
          transport: item.transport,
          toolCount: item.toolCount,
          icon: item.icon,
          enabled: Boolean(matched?.enabled),
          ...(matched ? { serverId: matched.id } : {}),
        }
      })
    },

    async enableFromCatalog(catalogId: string, scope: McpScope, targetIds: string[] = []): Promise<McpServer> {
      const template = findCatalogTemplate(catalogId)
      if (!template) throw new AppError(404, '市场目录里没有这项。')
      if (scope !== 'global' && scope !== 'friends' && scope !== 'groups') throw new AppError(400, '作用域不正确。')
      const chosen = [...new Set(targetIds.map((item) => item.trim()).filter(Boolean))]
      if (scope === 'friends' && chosen.length === 0) throw new AppError(400, '指定好友时至少勾选一个。')
      if (scope === 'groups' && chosen.length === 0) throw new AppError(400, '指定群聊时至少选一个。')
      if (scope === 'friends') {
        const friends = (await database.read()).stores.friends
        for (const id of chosen) {
          if (!friends.some((friend) => friend.id === id)) throw new AppError(400, `找不到好友 ${id}`)
        }
      }
      const existing = (await database.read()).stores.mcpServers
        .map(normalize)
        .find((server) => server.catalogId === catalogId || server.id === catalogId || server.name === template.name)
      return this.upsert({
        id: existing?.id ?? catalogId,
        name: template.name,
        enabled: true,
        transport: template.transport,
        command: template.command,
        args: template.args,
        url: template.url,
        env: existing?.env ?? [],
        headers: existing?.headers ?? [],
        scope,
        friendIds: scope === 'friends' ? chosen : [],
        groupIds: scope === 'groups' ? chosen : [],
        catalogId,
      })
    },

    /**
     * 把本群专属 MCP 收成这份 id 列表。
     * 全局和指定好友的服务不在这里改，避免把处处可用的服务收成仅本群。
     */
    async setGroupBindings(conversationId: string, serverIds: string[]): Promise<void> {
      const wanted = [...new Set(serverIds.map((item) => item.trim()).filter(Boolean))]
      const lineage = await database.update((document) => {
        const conversation = document.stores.conversations.find((item) => item.id === conversationId)
        if (!conversation || conversation.kind !== 'group') throw new AppError(400, '只有群聊可以挂 MCP。')
        const lineageId = conversation.lineageId || conversation.id
        const wantedSet = new Set(wanted)
        for (const id of wanted) {
          const server = document.stores.mcpServers.find((item) => item.id === id)
          if (!server) throw new AppError(400, '找不到这个 MCP 服务')
          const scope = server.scope ?? 'global'
          if (scope === 'global') throw new AppError(400, `「${server.name}」是全局服务，已经处处可用。`)
          if (scope === 'friends') throw new AppError(400, `「${server.name}」挂在指定好友上，不能改挂到群。`)
          if (scope !== 'groups') throw new AppError(400, `「${server.name}」不能挂到群。`)
        }
        for (const server of document.stores.mcpServers) {
          if (server.scope !== 'groups') continue
          const current = server.groupIds ?? []
          const has = current.includes(lineageId)
          const keep = wantedSet.has(server.id)
          if (has && !keep) {
            const next = current.filter((id) => id !== lineageId)
            if (next.length > 0) server.groupIds = next
            else delete server.groupIds
            server.updatedAt = Date.now()
          } else if (keep && !has) {
            server.groupIds = [...current, lineageId]
            server.updatedAt = Date.now()
          }
        }
        return lineageId
      })
      log('info', 'mcp', '更新群 MCP', { conversationId, lineageId: lineage, count: wanted.length })
    },

    async listResources(serverId: string): Promise<McpResource[]> {
      const server = await read(serverId)
      const catalogId = server.catalogId || server.id
      const template = findCatalogTemplate(catalogId) ?? findCatalogTemplate(server.name)
      return template?.resources ?? []
    },

    async listPrompts(serverId: string): Promise<McpPrompt[]> {
      const server = await read(serverId)
      const catalogId = server.catalogId || server.id
      const template = findCatalogTemplate(catalogId) ?? findCatalogTemplate(server.name)
      return template?.prompts ?? []
    },

    /** 给发送回合用。只收集已启用、且对这个会话和发言人可见的服务。 */
    async catalogForChat(target: McpChatTarget): Promise<ToolCatalog> {
      const servers = (await database.read()).stores.mcpServers
        .map(normalize)
        .filter((server) => server.enabled && mcpAppliesToChat(server, target))
      return hub.catalogForChat(servers, materialize)
    },

    async closeAll(): Promise<void> {
      await hub.closeAll()
    },
  }
}

async function bindingsToRecord(
  bindings: McpEnvBinding[],
  reveal: (secretId: string) => Promise<RevealedSecret | undefined>,
): Promise<Record<string, string>> {
  const record: Record<string, string> = {}
  for (const binding of bindings) {
    const vaultEntryId = binding.vaultEntryId || (binding as McpEnvBinding & { secretId?: string }).secretId
    if (vaultEntryId) {
      const secret = await reveal(vaultEntryId)
      if (!secret) throw new AppError(400, `${binding.name} 的保险库条目不存在。`)
      const value = secret.apiKey || secret.password
      if (!value) throw new AppError(400, `${binding.name} 的保险库条目是空的。`)
      record[binding.name] = value
    } else if (binding.value) {
      record[binding.name] = binding.value
    }
  }
  return record
}

function sanitizeEnv(bindings: McpEnvBinding[]): McpEnvBinding[] {
  return bindings
    .map((binding) => {
      const vaultEntryId = binding.vaultEntryId || (binding as McpEnvBinding & { secretId?: string }).secretId
      return {
        name: binding.name.trim(),
        ...(vaultEntryId ? { vaultEntryId } : {}),
        // 已经引用保险库时不再另存一份明文。
        ...(!vaultEntryId && binding.value?.trim() ? { value: binding.value.trim() } : {}),
      }
    })
    .filter((binding) => binding.name.length > 0)
}

function normalize(server: McpServer): McpServer {
  return {
    ...server,
    env: server.env ?? [],
    headers: server.headers ?? [],
  }
}
