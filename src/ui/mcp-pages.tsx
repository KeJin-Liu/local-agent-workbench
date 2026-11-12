/**
 * p0.5 MCP：已配置 ⇄ 市场；Resources / Prompts 二级页。
 * 启用 sheet 未点「完成」不写库；选用资源只排队进当前 composer。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { groupLineage, latestGroups } from '../app/directory.ts'
import type { ConversationCard, Friend, McpCatalogEntry, McpPrompt, McpResource, McpServerView, PublicSecret } from '../domain/types.ts'
import { requestJson } from './api.ts'
import { Avatar } from './avatar.tsx'

export type McpSection = 'configured' | 'market' | 'resources'

export function McpShell({
  section,
  secrets,
  friends,
  resourceServerId,
  onSection,
  onOpenResources,
  onInsertComposer,
  onBackChat,
}: {
  section: McpSection
  secrets: PublicSecret[]
  friends: Friend[]
  resourceServerId: string | null
  onSection: (section: McpSection) => void
  onOpenResources: (serverId: string) => void
  onInsertComposer: (text: string) => void
  onBackChat?: () => void
}) {
  if (section === 'market') {
    return (
      <McpMarketPage
        friends={friends}
        onConfigured={() => onSection('configured')}
        onOpenResources={onOpenResources}
      />
    )
  }
  if (section === 'resources') {
    return (
      <McpResourcesPage
        serverId={resourceServerId}
        onConfigured={() => onSection('configured')}
        onMarket={() => onSection('market')}
        onInsertComposer={onInsertComposer}
        onBackChat={onBackChat}
      />
    )
  }
  return (
    <McpConfiguredPage
      secrets={secrets}
      onMarket={() => onSection('market')}
      onOpenResources={onOpenResources}
    />
  )
}

function McpSeg({
  active,
  onConfigured,
  onMarket,
  trailing,
}: {
  active: 'configured' | 'market'
  onConfigured: () => void
  onMarket: () => void
  trailing?: ReactNode
}) {
  return (
    <header className="page-hd">
      <div>
        <div className="page-title">MCP</div>
        <div className="page-seg" role="tablist" aria-label="MCP 分段">
          <button
            type="button"
            className={active === 'configured' ? 'seg-btn is-active' : 'seg-btn'}
            role="tab"
            aria-selected={active === 'configured'}
            onClick={onConfigured}
          >
            已配置
          </button>
          <button
            type="button"
            className={active === 'market' ? 'seg-btn is-active' : 'seg-btn'}
            role="tab"
            aria-selected={active === 'market'}
            onClick={onMarket}
          >
            市场
          </button>
        </div>
      </div>
      <div className="grow" />
      {trailing}
    </header>
  )
}

function McpConfiguredPage({
  secrets,
  onMarket,
  onOpenResources,
}: {
  secrets: PublicSecret[]
  onMarket: () => void
  onOpenResources: (serverId: string) => void
}) {
  // Reuse existing form panel via dynamic import-like inline — keep list + link to resources
  const [servers, setServers] = useState<McpServerView[]>([])
  const [editing, setEditing] = useState<McpServerView | null | 'new'>(null)
  const [error, setError] = useState('')

  async function reload() {
    const payload = await requestJson<{ ok: true; servers: McpServerView[] }>('/api/mcp')
    setServers(payload.servers)
  }

  useEffect(() => {
    void reload().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '读不到 MCP'))
  }, [])

  const current = editing && editing !== 'new' ? servers.find((item) => item.id === editing.id) ?? editing : null

  return (
    <div className="page">
      <McpSeg
        active="configured"
        onConfigured={() => undefined}
        onMarket={onMarket}
        trailing={
          <button className="btn" type="button" onClick={() => setEditing('new')}>
            ＋ 添加服务
          </button>
        }
      />
      <div className="page-bd">
        <div className="page-layout">
          <section className="card" aria-label="已配置服务">
            <div className="card-hd">
              <h2>已配置服务</h2>
              <div className="grow" />
              <span className="tag">{servers.length}</span>
            </div>
            <div className="card-bd" style={{ padding: 8 }}>
              {servers.length === 0 ? <p className="empty">还没有服务。可从市场启用，或手动添加。</p> : null}
              {servers.map((server) => (
                <div key={server.id} className={current?.id === server.id ? 'list-item is-active' : 'list-item'}>
                  <button
                    type="button"
                    className="list-item"
                    style={{ flex: 1, padding: 0, border: 0, background: 'transparent' }}
                    onClick={() => setEditing(server)}
                  >
                    <span className="list-item-meta">
                      <span className="list-item-title">{server.name}</span>
                      <span className="list-item-desc">
                        {server.transport}
                        {server.enabled ? ' · 已启用' : ' · 未启用'}
                        {mcpScopeLabel(server)}
                      </span>
                    </span>
                  </button>
                  {server.enabled ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenResources(server.id)}>
                      Resources
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <ConfiguredEditor
            key={editing === 'new' ? 'new' : current?.id ?? 'none'}
            editing={editing}
            current={current}
            secrets={secrets}
            onReload={async () => {
              await reload()
            }}
            onClose={() => setEditing(null)}
            onOpenResources={onOpenResources}
            setError={setError}
          />
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </div>
  )
}

function ConfiguredEditor({
  editing,
  current,
  secrets,
  onReload,
  onClose,
  onOpenResources,
  setError,
}: {
  editing: McpServerView | null | 'new'
  current: McpServerView | null
  secrets: PublicSecret[]
  onReload: () => Promise<void>
  onClose: () => void
  onOpenResources: (serverId: string) => void
  setError: (message: string) => void
}) {
  if (!editing) {
    return (
      <section className="card">
        <div className="card-bd">
          <p className="help">选左侧服务编辑，或从市场启用。</p>
        </div>
      </section>
    )
  }
  return (
    <ConfiguredForm
      seed={editing === 'new' ? null : current}
      secrets={secrets}
      onSaved={async (id) => {
        await onReload()
        onClose()
        if (id) onOpenResources(id)
      }}
      onCancel={onClose}
      setError={setError}
      onOpenResources={onOpenResources}
    />
  )
}

function ConfiguredForm({
  seed,
  secrets,
  onSaved,
  onCancel,
  setError,
  onOpenResources,
}: {
  seed: McpServerView | null
  secrets: PublicSecret[]
  onSaved: (id?: string) => Promise<void>
  onCancel: () => void
  setError: (message: string) => void
  onOpenResources: (serverId: string) => void
}) {
  const [name, setName] = useState(seed?.name ?? '')
  const [transport, setTransport] = useState(seed?.transport ?? 'stdio')
  const [command, setCommand] = useState(seed?.command ?? '')
  const [url, setUrl] = useState(seed?.url ?? '')
  const [argsText, setArgsText] = useState((seed?.args ?? []).join(' '))
  const [enabled, setEnabled] = useState(seed?.enabled ?? false)
  const [pending, setPending] = useState(false)

  async function save() {
    setPending(true)
    setError('')
    try {
      const body = {
        name,
        transport,
        command: transport === 'stdio' ? command : undefined,
        url: transport === 'stdio' ? undefined : url,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
        enabled,
        env: seed?.env ?? [],
        headers: seed?.headers ?? [],
        scope: seed?.scope,
        friendIds: seed?.friendIds,
        groupIds: seed?.groupIds,
        catalogId: seed?.catalogId,
      }
      const payload = seed
        ? await requestJson<{ ok: true; server: McpServerView }>(`/api/mcp/${encodeURIComponent(seed.id)}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          })
        : await requestJson<{ ok: true; server: McpServerView }>('/api/mcp', {
            method: 'POST',
            body: JSON.stringify(body),
          })
      await onSaved(payload.server.enabled ? payload.server.id : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="card">
      <div className="card-hd">
        <h2>{seed ? `编辑 · ${seed.name}` : '手动添加服务'}</h2>
      </div>
      <div className="card-bd form">
        <label className="inset-row">
          <span className="inset-label">名称</span>
          <input className="inset-value" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="inset-row">
          <span className="inset-label">传输</span>
          <select className="inset-value" value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}>
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className="inset-row">
              <span className="inset-label">命令</span>
              <input className="inset-value" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="inset-row">
              <span className="inset-label">参数</span>
              <input className="inset-value" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="空格分隔" />
            </label>
          </>
        ) : (
          <label className="inset-row">
            <span className="inset-label">URL</span>
            <input className="inset-value" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        )}
        <label className="inset-row" style={{ justifyContent: 'space-between' }}>
          <span className="inset-label">启用</span>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        {secrets.length === 0 ? <p className="help">环境变量/请求头可在保存后于旧编辑器扩展；当前表单覆盖主字段。</p> : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-sm" disabled={pending || !name.trim()} onClick={() => void save()}>
            {pending ? '保存中' : '保存'}
          </button>
          {seed?.enabled ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenResources(seed.id)}>
              打开 Resources / Prompts
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function McpMarketPage({
  friends,
  onConfigured,
  onOpenResources,
}: {
  friends: Friend[]
  onConfigured: () => void
  onOpenResources: (serverId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<McpCatalogEntry[]>([])
  const [error, setError] = useState('')
  const [enabling, setEnabling] = useState<McpCatalogEntry | null>(null)
  const [toast, setToast] = useState('')

  async function reload(q = query) {
    const payload = await requestJson<{ ok: true; entries: McpCatalogEntry[] }>(
      `/api/mcp/catalog?q=${encodeURIComponent(q)}`,
    )
    setEntries(payload.entries)
  }

  useEffect(() => {
    void reload('').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '读不到市场'))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div className="page">
      <McpSeg
        active="market"
        onConfigured={onConfigured}
        onMarket={() => undefined}
        trailing={
          <input
            className="search"
            style={{ maxWidth: 220 }}
            placeholder="搜索目录…"
            value={query}
            onChange={(event) => {
              const value = event.target.value
              setQuery(value)
              void reload(value).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '搜索失败'))
            }}
          />
        }
      />
      <div className="page-bd">
        <div className="mcp-market-grid">
          {entries.map((entry) => (
            <article key={entry.id} className="mcp-card" data-id={entry.id} data-enabled={entry.enabled ? '1' : '0'}>
              <div className="mcp-card-icon" aria-hidden="true">
                {entry.icon}
              </div>
              <div className="mcp-card-body">
                <div className="mcp-card-title-row">
                  <h3 className="mcp-card-title">{entry.name}</h3>
                  {entry.enabled ? <span className="tag tag-ok">已启用</span> : null}
                </div>
                <p className="mcp-card-desc">{entry.summary}</p>
                <div className="mcp-card-meta">
                  <span className="chip chip-muted">{entry.transport}</span>
                  <span className="chip chip-muted">{entry.toolCount} 工具</span>
                </div>
              </div>
              <div className="mcp-card-actions">
                {entry.enabled ? (
                  <>
                    <button className="btn btn-secondary btn-sm btn-enable is-enabled" type="button" disabled>
                      已启用
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => onOpenResources(entry.serverId || entry.id)}
                    >
                      Resources
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-enable" type="button" onClick={() => setEnabling(entry)}>
                    启用
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {entries.length === 0 ? <div className="empty">没有匹配的目录项 · 试试别的关键词</div> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      {enabling ? (
        <EnableSheet
          entry={enabling}
          friends={friends}
          onClose={() => setEnabling(null)}
          onDone={(serverId) => {
            setEnabling(null)
            setToast('已写入本地配置')
            void reload()
            onOpenResources(serverId)
          }}
        />
      ) : null}
      <div className="toast" hidden={!toast}>
        {toast}
      </div>
    </div>
  )
}

function mcpScopeLabel(server: McpServerView): string {
  if (server.scope === 'friends') return ' · 指定好友'
  if (server.scope === 'groups') {
    const count = server.groupIds?.length ?? 0
    return count > 0 ? ` · 指定群 · ${count}` : ' · 指定群'
  }
  if (server.scope === 'global') return ' · 全局'
  return ''
}

function EnableSheet({
  entry,
  friends,
  onClose,
  onDone,
}: {
  entry: McpCatalogEntry
  friends: Friend[]
  onClose: () => void
  onDone: (serverId: string) => void
}) {
  const [scope, setScope] = useState<'global' | 'friends' | 'groups'>('global')
  const [picked, setPicked] = useState<string[]>([])
  const [groups, setGroups] = useState<Array<{ lineageId: string; title: string }>>([])
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const selectable = friends.filter((friend) => !friend.isOwnerTemplate)
  const ready = scope === 'global' || (scope === 'friends' && picked.length > 0) || (scope === 'groups' && pickedGroups.length > 0)

  useEffect(() => {
    let stop = false
    void requestJson<{ ok: true; conversations: ConversationCard[] }>('/api/workbench')
      .then((payload) => {
        if (stop) return
        setGroups(
          latestGroups(payload.conversations).map((item) => ({
            lineageId: groupLineage(item),
            title: item.title,
          })),
        )
      })
      .catch(() => {
        if (!stop) setGroups([])
      })
    return () => {
      stop = true
    }
  }, [])

  async function confirm() {
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; server: { id: string } }>(
        `/api/mcp/catalog/${encodeURIComponent(entry.id)}/enable`,
        {
          method: 'POST',
          body: JSON.stringify({
            scope,
            friendIds: scope === 'friends' ? picked : [],
            groupIds: scope === 'groups' ? pickedGroups : [],
          }),
        },
      )
      onDone(payload.server.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '启用失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-labelledby="enableSheetTitle">
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-hd">
          <button type="button" className="sheet-side leading" onClick={onClose}>
            取消
          </button>
          <h2 id="enableSheetTitle">启用 MCP</h2>
          <button type="button" className="sheet-side trailing" disabled={pending || !ready} onClick={() => void confirm()}>
            {pending ? '写入中' : '完成'}
          </button>
        </div>
        <div className="sheet-bd">
          <p className="mcp-enable-name">{entry.name}</p>
          <p className="help" style={{ margin: '0 0 12px' }}>
            写入本地配置后出现在「已配置」。须先选作用域。未点完成不改本地配置。
          </p>
          <div className="confirm-q">挂到哪里？</div>
          <div className="scope-options">
            <button
              type="button"
              className={scope === 'global' ? 'scope-opt is-selected' : 'scope-opt'}
              onClick={() => setScope('global')}
            >
              <span className="radio" aria-hidden="true" />
              <span>
                <div className="opt-title">全局（所有好友可用）</div>
                <div className="opt-desc">任意好友回合都可调用这些工具</div>
              </span>
            </button>
            <button
              type="button"
              className={scope === 'friends' ? 'scope-opt is-selected' : 'scope-opt'}
              onClick={() => setScope('friends')}
            >
              <span className="radio" aria-hidden="true" />
              <span>
                <div className="opt-title">指定好友</div>
                <div className="opt-desc">仅勾选的好友发言时可调用</div>
              </span>
            </button>
            <button
              type="button"
              className={scope === 'groups' ? 'scope-opt is-selected' : 'scope-opt'}
              onClick={() => setScope('groups')}
            >
              <span className="radio" aria-hidden="true" />
              <span>
                <div className="opt-title">指定群聊</div>
                <div className="opt-desc">仅勾选的群可用，群里谁发言都能调用</div>
              </span>
            </button>
          </div>
          {scope === 'friends' ? (
            <div className="friend-multi" aria-label="选择好友">
              {selectable.map((friend) => {
                const checked = picked.includes(friend.id)
                return (
                  <button
                    key={friend.id}
                    type="button"
                    className={checked ? 'friend-multi-item is-checked' : 'friend-multi-item'}
                    onClick={() =>
                      setPicked((current) =>
                        checked ? current.filter((id) => id !== friend.id) : [...current, friend.id],
                      )
                    }
                  >
                    <span className="check" />
                    <Avatar avatar={friend.avatar} name={friend.name} size="sm" /> {friend.name}
                  </button>
                )
              })}
            </div>
          ) : null}
          {scope === 'groups' ? (
            <div className="friend-multi" aria-label="选择群聊">
              {groups.length === 0 ? <p className="help">还没有群聊。先发起群，再挂到这个群。</p> : null}
              {groups.map((group) => {
                const checked = pickedGroups.includes(group.lineageId)
                return (
                  <button
                    key={group.lineageId}
                    type="button"
                    className={checked ? 'friend-multi-item is-checked' : 'friend-multi-item'}
                    onClick={() =>
                      setPickedGroups((current) =>
                        checked ? current.filter((id) => id !== group.lineageId) : [...current, group.lineageId],
                      )
                    }
                  >
                    <span className="check" />
                    {group.title}
                  </button>
                )
              })}
            </div>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <p className="confirm-note">点「完成」才写入；取消不改配置。</p>
        </div>
      </div>
    </div>
  )
}

function McpResourcesPage({
  serverId,
  onConfigured,
  onMarket,
  onInsertComposer,
  onBackChat,
}: {
  serverId: string | null
  onConfigured: () => void
  onMarket: () => void
  onInsertComposer: (text: string) => void
  onBackChat?: () => void
}) {
  const [pane, setPane] = useState<'resources' | 'prompts'>('resources')
  const [resources, setResources] = useState<McpResource[]>([])
  const [prompts, setPrompts] = useState<McpPrompt[]>([])
  const [selected, setSelected] = useState<{ kind: 'resources' | 'prompts'; id: string } | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [title, setTitle] = useState(serverId ?? 'MCP')

  useEffect(() => {
    if (!serverId) return
    let cancelled = false
    void (async () => {
      try {
        const [res, pro, servers] = await Promise.all([
          requestJson<{ ok: true; resources: McpResource[] }>(`/api/mcp/${encodeURIComponent(serverId)}/resources`),
          requestJson<{ ok: true; prompts: McpPrompt[] }>(`/api/mcp/${encodeURIComponent(serverId)}/prompts`),
          requestJson<{ ok: true; servers: McpServerView[] }>('/api/mcp'),
        ])
        if (cancelled) return
        setResources(res.resources)
        setPrompts(pro.prompts)
        const server = servers.servers.find((item) => item.id === serverId)
        setTitle(server?.name ?? serverId)
        const first = res.resources[0]
        setSelected(first ? { kind: 'resources', id: first.uri } : null)
        setPane('resources')
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读不到 Resources')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverId])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  const preview = useMemo(() => {
    if (!selected) return null
    if (selected.kind === 'resources') {
      const item = resources.find((row) => row.uri === selected.id)
      if (!item) return null
      return {
        kind: 'Resource' as const,
        name: item.name,
        uri: item.uri,
        body: item.textPreview || item.description || '',
      }
    }
    const item = prompts.find((row) => row.name === selected.id)
    if (!item) return null
    return {
      kind: 'Prompt' as const,
      name: item.name,
      uri: `prompt://${title}/${item.name}`,
      body:
        item.template ||
        [item.description, ...(item.arguments ?? []).map((arg) => `- ${arg.name}${arg.required ? ' (required)' : ''}`)].filter(Boolean).join('\n'),
    }
  }, [selected, resources, prompts, title])

  function insert() {
    if (!preview) return
    const text =
      preview.kind === 'Prompt'
        ? preview.body
        : `【选用 Resource】${preview.name}\n${preview.uri}\n\n${preview.body}`
    onInsertComposer(text)
    setToast('已排队插入当前对话输入框')
  }

  if (!serverId) {
    return (
      <div className="page">
        <header className="page-hd">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onConfigured}>
            ‹ 已配置
          </button>
          <div className="page-title">Resources / Prompts</div>
        </header>
        <div className="page-bd">
          <p className="empty">先启用或选择一个 MCP 服务。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-hd">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onConfigured} aria-label="返回已配置">
          ‹ 已配置
        </button>
        <div>
          <div className="page-title">{title}</div>
          <div className="page-seg" role="tablist">
            <button
              type="button"
              className={pane === 'resources' ? 'seg-btn is-active' : 'seg-btn'}
              onClick={() => {
                setPane('resources')
                const first = resources[0]
                setSelected(first ? { kind: 'resources', id: first.uri } : null)
              }}
            >
              Resources
            </button>
            <button
              type="button"
              className={pane === 'prompts' ? 'seg-btn is-active' : 'seg-btn'}
              onClick={() => {
                setPane('prompts')
                const first = prompts[0]
                setSelected(first ? { kind: 'prompts', id: first.name } : null)
              }}
            >
              Prompts
            </button>
          </div>
        </div>
        <div className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onMarket}>
          市场
        </button>
        {onBackChat ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBackChat}>
            返回聊天
          </button>
        ) : null}
      </header>
      <div className="page-bd">
        <div className="mcp-rp-layout">
          <section className="card">
            <div className="card-hd">
              <h2 id="listTitle">{pane === 'prompts' ? 'Prompts' : 'Resources'}</h2>
            </div>
            <div className="card-bd" style={{ padding: 8 }}>
              {pane === 'resources'
                ? resources.map((item) => (
                    <button
                      key={item.uri}
                      type="button"
                      className={selected?.kind === 'resources' && selected.id === item.uri ? 'list-item is-active rp-item' : 'list-item rp-item'}
                      onClick={() => setSelected({ kind: 'resources', id: item.uri })}
                    >
                      <span className="list-item-meta">
                        <span className="list-item-title">{item.name}</span>
                        <span className="list-item-desc mono">{item.uri}</span>
                      </span>
                    </button>
                  ))
                : prompts.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className={selected?.kind === 'prompts' && selected.id === item.name ? 'list-item is-active rp-item' : 'list-item rp-item'}
                      onClick={() => setSelected({ kind: 'prompts', id: item.name })}
                    >
                      <span className="list-item-meta">
                        <span className="list-item-title">{item.name}</span>
                        <span className="list-item-desc mono">prompt://{title}/{item.name}</span>
                      </span>
                    </button>
                  ))}
              {(pane === 'resources' ? resources : prompts).length === 0 ? (
                <p className="empty">这个服务还没有可预览的{pane === 'prompts' ? ' Prompts' : ' Resources'}。</p>
              ) : null}
            </div>
          </section>
          <section className="card">
            <div className="card-hd">
              <h2>预览</h2>
              <div className="grow" />
              <span className="tag" id="previewKind">
                {preview?.kind ?? '—'}
              </span>
            </div>
            <div className="card-bd">
              {preview ? (
                <>
                  <div className="list-item-title" style={{ marginBottom: 6 }}>
                    {preview.name}
                  </div>
                  <div className="list-item-desc mono" style={{ marginBottom: 12 }}>
                    {preview.uri}
                  </div>
                  <pre className="rp-preview">{preview.body}</pre>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button type="button" className="btn btn-sm" onClick={insert}>
                      选用 / 插入到当前对话
                    </button>
                  </div>
                </>
              ) : (
                <p className="help">从左侧选一项预览。</p>
              )}
            </div>
          </section>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      <div className="toast" hidden={!toast}>
        {toast}
      </div>
    </div>
  )
}
