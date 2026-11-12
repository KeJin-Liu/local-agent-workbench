/**
 * 设置：MCP 服务和本地保险库。密钥明文不回显。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { McpEnvBinding, McpServerView, McpToolPreview, PublicSecret, SecretKind } from '../domain/types.ts'
import { requestJson } from './api.ts'

export function SettingsHub({
  onOpen,
  sendWaitSeconds,
  onSendWaitSecondsChange,
}: {
  onOpen: (page: 'providers' | 'mcp' | 'mcp-market' | 'vault' | 'friends' | 'tasks' | 'mail') => void
  sendWaitSeconds: number
  onSendWaitSecondsChange: (seconds: number) => Promise<void>
}) {
  const items = [
    { page: 'providers' as const, icon: '🧠', title: '模型提供方', desc: 'Ollama / LM Studio / OpenAI / DeepSeek / Cursor' },
    { page: 'mail' as const, icon: '✉️', title: '邮箱 / 工作指令', desc: 'IMAP · SMTP · 白名单 · 计划提示词' },
    { page: 'mcp' as const, icon: '🔌', title: 'MCP 服务', desc: '已配置 · 市场 · Resources/Prompts' },
    { page: 'mcp-market' as const, icon: '🛒', title: 'MCP 市场', desc: '本地目录浏览与启用' },
    { page: 'vault' as const, icon: '🔑', title: '密码库', desc: 'API Key 与登录凭据' },
    { page: 'friends' as const, icon: '👤', title: '好友管理', desc: '头像 · 提示词 · 默认模型' },
    { page: 'tasks' as const, icon: '📅', title: '自动化任务', desc: '手动或定时，绑定好友执行' },
  ]
  const [waitSeconds, setWaitSeconds] = useState(sendWaitSeconds)
  const [savingWait, setSavingWait] = useState(false)
  const [waitError, setWaitError] = useState('')

  useEffect(() => {
    setWaitSeconds(sendWaitSeconds)
  }, [sendWaitSeconds])

  async function bumpWait(delta: number) {
    const next = Math.min(10, Math.max(1, waitSeconds + delta))
    if (next === waitSeconds || savingWait) return
    setWaitError('')
    setSavingWait(true)
    setWaitSeconds(next)
    try {
      await onSendWaitSecondsChange(next)
    } catch (cause) {
      setWaitSeconds(sendWaitSeconds)
      setWaitError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSavingWait(false)
    }
  }

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">模型提供方 · MCP · 密码库 · 关于</div>
        </div>
      </header>
      <div className="page-bd">
        <div className="page-layout-wide" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
          <div>
            <div className="inset-section-title">快捷入口</div>
            <div className="inset-group settings-quick">
              {items.map((item) => (
                <button key={item.page} type="button" className="list-item" onClick={() => onOpen(item.page)}>
                  <span style={{ fontSize: 20, width: 28, textAlign: 'center' }} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="list-item-meta">
                    <span className="list-item-title">{item.title}</span>
                    <span className="list-item-desc">{item.desc}</span>
                  </span>
                  <span className="chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="inset-section-title">发送行为</div>
            <div className="inset-group">
              <div className="inset-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>发送后等待窗口</div>
                  <div className="help">发送后先等待再调模型（全局 1–10 秒）；期间可点「终止」并回填输入框</div>
                </div>
                <div className="stepper" role="group" aria-label="发送后等待秒数">
                  <button
                    type="button"
                    className="stepper-btn"
                    aria-label="减少"
                    disabled={savingWait || waitSeconds <= 1}
                    onClick={() => void bumpWait(-1)}
                  >
                    −
                  </button>
                  <span className="stepper-value">{waitSeconds} 秒</span>
                  <button
                    type="button"
                    className="stepper-btn"
                    aria-label="增加"
                    disabled={savingWait || waitSeconds >= 10}
                    onClick={() => void bumpWait(1)}
                  >
                    +
                  </button>
                </div>
              </div>
              {waitError ? <p className="form-error" style={{ padding: '0 14px 10px' }}>{waitError}</p> : null}
            </div>
          </div>
          <section className="card">
            <div className="card-hd">
              <h2>关于与数据</h2>
            </div>
            <div className="card-bd" style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
              <p>本地智能体聊天工作台 · 数据全本地，无云账号。</p>
              <p>库文件：data/agent_workbench.json · 保险库密钥：data/vault.key · 头像：data/avatars/</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage({
  section,
  secrets,
  onChanged,
}: {
  section: 'mcp' | 'vault'
  secrets: PublicSecret[]
  onChanged: () => Promise<void>
}) {
  return section === 'vault' ? <VaultPanel secrets={secrets} onChanged={onChanged} /> : <McpPanel secrets={secrets} />
}

function McpPanel({ secrets }: { secrets: PublicSecret[] }) {
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
  const dot = (status: McpServerView['connection']['status'], enabled: boolean) =>
    !enabled ? 'status-dot' : status === 'connected' ? 'status-dot on' : status === 'error' ? 'status-dot err' : status === 'connecting' ? 'status-dot warn' : 'status-dot'

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">MCP 管理</div>
          <div className="page-sub">stdio / SSE / HTTP · 启用开关 · 工具列表只读预览</div>
        </div>
        <div className="grow" />
        <button className="btn" type="button" onClick={() => setEditing('new')}>
          ＋ 添加服务
        </button>
      </header>
      <div className="page-bd">
        {error ? <p className="form-error">{error}</p> : null}
        <div className="page-layout">
          <section className="card">
            <div className="card-hd">
              <h2>已配置服务</h2>
              <div className="grow" />
              <span className="tag">{servers.length}</span>
            </div>
            <div className="card-bd" style={{ padding: 8 }}>
              {servers.length === 0 ? <p className="empty">还没有 MCP 服务。</p> : null}
              {servers.map((server) => (
                <div key={server.id} className={current?.id === server.id ? 'list-item is-active' : 'list-item'}>
                  <button type="button" className="list-item" style={{ flex: 1, padding: 0, border: 0 }} onClick={() => setEditing(server)}>
                    <span className={dot(server.connection.status, server.enabled)} title={statusLabel(server.connection.status)} />
                    <span className="list-item-meta">
                      <span className="list-item-title">{server.name}</span>
                      <span className="list-item-desc">
                        {server.transport} · {server.transport === 'stdio' ? server.command : server.url}
                        {server.enabled ? '' : ' · 已停用'}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={server.enabled ? 'toggle is-on' : 'toggle'}
                    aria-label="启用"
                    onClick={() => {
                      void requestJson(`/api/mcp/${encodeURIComponent(server.id)}`, {
                        method: 'PUT',
                        body: JSON.stringify({ ...server, enabled: !server.enabled }),
                      }).then(() => reload())
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            {editing ? (
              <McpForm
                secrets={secrets}
                server={editing === 'new' ? null : current}
                tools={current?.connection.tools ?? []}
                onClose={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null)
                  await reload()
                }}
                onConnect={async (id) => {
                  await requestJson(`/api/mcp/${encodeURIComponent(id)}/connect`, { method: 'POST' })
                  await reload()
                }}
                onDisconnect={async (id) => {
                  await requestJson(`/api/mcp/${encodeURIComponent(id)}/disconnect`, { method: 'POST' })
                  await reload()
                }}
              />
            ) : (
              <p className="empty">选一个服务，或添加一个。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function statusLabel(status: McpServerView['connection']['status']): string {
  if (status === 'connected') return '已连接'
  if (status === 'connecting') return '连接中'
  if (status === 'error') return '连接失败'
  return '未连接'
}

function ToolPreview({ id, onDone }: { id: string; onDone: () => void }) {
  const [tools, setTools] = useState<McpToolPreview[] | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  return (
    <div>
      <button
        type="button"
        className="button ghost"
        disabled={pending}
        onClick={() => {
          setPending(true)
          setError('')
          void requestJson<{ ok: true; tools: McpToolPreview[] }>(`/api/mcp/${encodeURIComponent(id)}/tools`, { method: 'POST' })
            .then((payload) => {
              setTools(payload.tools)
              onDone()
            })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '预览失败'))
            .finally(() => setPending(false))
        }}
      >
        {pending ? '正在连接…' : '预览工具'}
      </button>
      {error ? <p className="form-error">{error}</p> : null}
      {tools ? (
        tools.length === 0 ? (
          <p className="hint">这个服务没有暴露工具。</p>
        ) : (
          <ul className="tool-list">
            {tools.map((tool) => (
              <li key={tool.name}>
                <strong>{tool.name}</strong>
                {tool.description ? <span className="row-meta">{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}

type BindingDraft = { name: string; vaultEntryId: string; value: string }

function toDrafts(bindings: McpEnvBinding[] | undefined): BindingDraft[] {
  return (bindings ?? []).map((binding) => ({
    name: binding.name,
    vaultEntryId: binding.vaultEntryId ?? '',
    value: binding.value ?? '',
  }))
}

function rowsToBindings(rows: BindingDraft[]) {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => ({
      name: row.name.trim(),
      ...(row.vaultEntryId ? { vaultEntryId: row.vaultEntryId } : {}),
      ...(!row.vaultEntryId && row.value.trim() ? { value: row.value.trim() } : {}),
    }))
}

function BindingEditor({
  label,
  rows,
  secrets,
  onChange,
}: {
  label: string
  rows: BindingDraft[]
  secrets: PublicSecret[]
  onChange: (rows: BindingDraft[]) => void
}) {
  function patch(index: number, next: Partial<BindingDraft>) {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...next } : row)))
  }
  return (
    <fieldset className="bindings">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="binding-row" key={index}>
          <input
            value={row.name}
            spellCheck={false}
            placeholder="名称"
            aria-label={`${label}名称`}
            onChange={(event) => patch(index, { name: event.target.value })}
          />
          <input
            value={row.value}
            spellCheck={false}
            placeholder="非秘密明文"
            aria-label={`${label}值`}
            disabled={Boolean(row.vaultEntryId)}
            onChange={(event) => patch(index, { value: event.target.value })}
          />
          <select
            value={row.vaultEntryId}
            aria-label={`${label}保险库`}
            onChange={(event) => patch(index, { vaultEntryId: event.target.value })}
          >
            <option value="">不引用保险库</option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </select>
          <button type="button" className="button ghost" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button ghost"
        onClick={() => onChange([...rows, { name: '', vaultEntryId: '', value: '' }])}
      >
        添加{label}
      </button>
    </fieldset>
  )
}

function McpForm({
  server,
  secrets,
  tools,
  onSaved,
  onClose,
  onConnect,
  onDisconnect,
}: {
  server: McpServerView | null
  secrets: PublicSecret[]
  tools: McpToolPreview[]
  onSaved: () => Promise<void>
  onClose: () => void
  onConnect: (id: string) => Promise<void>
  onDisconnect: (id: string) => Promise<void>
}) {
  const [name, setName] = useState(server?.name ?? '')
  const [enabled, setEnabled] = useState(server?.enabled ?? false)
  const [transport, setTransport] = useState<'stdio' | 'sse' | 'http'>(server?.transport ?? 'stdio')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState((server?.args ?? []).join(' '))
  const [url, setUrl] = useState(server?.url ?? '')
  const [envRows, setEnvRows] = useState<BindingDraft[]>(toDrafts(server?.env))
  const [headerRows, setHeaderRows] = useState<BindingDraft[]>(toDrafts(server?.headers))
  const [error, setError] = useState('')

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const path = server ? `/api/mcp/${encodeURIComponent(server.id)}` : '/api/mcp'
      await requestJson(path, {
        method: server ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          enabled,
          transport,
          command,
          args: args.split(/\s+/).filter(Boolean),
          url,
          env: rowsToBindings(envRows),
          headers: rowsToBindings(headerRows),
        }),
      })
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有保存')
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: 'contents' }}>
      <div className="card-hd">
        <h2>{server ? `编辑 · ${name || server.name}` : '新建服务'}</h2>
        <div className="grow" />
        {server ? <span className={server.connection.status === 'connected' ? 'tag tag-ok' : 'tag'}>{statusLabel(server.connection.status)} · {tools.length} 个工具</span> : null}
        {server ? (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onConnect(server.id)}>
              连接
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onDisconnect(server.id)}>
              断开
            </button>
          </>
        ) : null}
      </div>
      <div className="card-bd">
        <div className="form">
          <div className="field-row">
            <div className="field">
              <label>名称<span className="req">*</span></label>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="field">
              <label>传输方式</label>
              <select
                value={transport}
                onChange={(event) => setTransport(event.target.value === 'http' ? 'http' : event.target.value === 'sse' ? 'sse' : 'stdio')}
              >
                <option value="stdio">stdio</option>
                <option value="sse">sse</option>
                <option value="http">http</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <button type="button" className={enabled ? 'toggle is-on' : 'toggle'} aria-pressed={enabled} onClick={() => setEnabled((value) => !value)} />
            <span style={{ fontSize: 13 }}>启用此服务</span>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="field">
                <label>命令<span className="req">*</span></label>
                <input value={command} spellCheck={false} placeholder="npx" onChange={(event) => setCommand(event.target.value)} />
              </div>
              <div className="field">
                <label>参数（空格分隔）</label>
                <input value={args} spellCheck={false} placeholder="-y @modelcontextprotocol/server-filesystem ." onChange={(event) => setArgs(event.target.value)} />
              </div>
            </>
          ) : (
            <div className="field">
              <label>URL<span className="req">*</span></label>
              <input value={url} spellCheck={false} placeholder="http://127.0.0.1:3001/mcp" onChange={(event) => setUrl(event.target.value)} />
            </div>
          )}
          <BindingEditor label="环境变量" rows={envRows} secrets={secrets} onChange={setEnvRows} />
          {transport !== 'stdio' ? <BindingEditor label="请求头" rows={headerRows} secrets={secrets} onChange={setHeaderRows} /> : null}
          {tools.length > 0 ? (
            <div className="field">
              <label>已发现工具（只读）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tools.map((tool) => (
                  <span key={tool.name} className="chip" title={tool.description}>
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          ) : server ? (
            <ToolPreview id={server.id} onDone={() => void onConnect(server.id)} />
          ) : null}
          {server?.connection.error ? <p className="form-error">{server.connection.error}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
      <div className="card-ft">
        {server ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginRight: 'auto', color: 'var(--danger)' }}
            onClick={() => {
              void requestJson(`/api/mcp/${encodeURIComponent(server.id)}`, { method: 'DELETE' }).then(() => onSaved())
            }}
          >
            删除
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn">
          保存
        </button>
      </div>
    </form>
  )
}

function VaultPanel({ secrets, onChanged }: { secrets: PublicSecret[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<PublicSecret | 'new' | null>(secrets[0] ?? null)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = secrets.filter((secret) => !needle || `${secret.name} ${secret.username ?? ''}`.toLowerCase().includes(needle))
  const selected = editing && editing !== 'new' ? secrets.find((item) => item.id === editing.id) ?? editing : null
  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">账户密码库</div>
          <div className="page-sub">API Key / 登录凭据 · AES 加密本机存储 · 提供方与 MCP 可引用</div>
        </div>
        <div className="grow" />
        <button className="btn" type="button" onClick={() => setEditing('new')}>
          ＋ 新建条目
        </button>
      </header>
      <div className="page-bd">
        <div className="page-layout">
          <section className="card">
            <div className="card-hd">
              <input className="search-input" type="search" placeholder="搜索名称 / 用户名" aria-label="搜索密码库" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="card-bd" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>用户名</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((secret) => (
                    <tr key={secret.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(secret)}>
                      <td>
                        <strong>{secret.name}</strong>
                      </td>
                      <td>
                        <span className="tag">{secret.kind === 'api-key' ? 'API Key' : '登录'}</span>
                      </td>
                      <td>{secret.username || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 ? <p className="empty">没有条目。</p> : null}
            </div>
          </section>
          <section className="card">
            {editing ? (
              <SecretForm
                key={editing === 'new' ? 'new' : editing.id}
                secret={editing === 'new' ? null : selected}
                onClose={() => setEditing(secrets[0] ?? null)}
                onSaved={async () => {
                  setEditing(null)
                  await onChanged()
                }}
              />
            ) : (
              <p className="empty">选一条，或新建。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

const REVEAL_VISIBLE_MS = 8000

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.append(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('复制失败')
}

function SecretForm({
  secret,
  onSaved,
  onClose,
}: {
  secret: PublicSecret | null
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(secret?.name ?? '')
  const [kind, setKind] = useState<SecretKind>(secret?.kind ?? 'api-key')
  const [username, setUsername] = useState(secret?.username ?? '')
  const [apiKey, setApiKey] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState('')
  const [showPlain, setShowPlain] = useState(false)
  const [copyNote, setCopyNote] = useState('')
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function hidePlain() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setShowPlain(false)
  }

  useEffect(() => hidePlain, [])

  async function loadPlain() {
    if (!secret) return revealed
    if (revealed) return revealed
    const payload = await requestJson<{ ok: true; secret: { apiKey?: string; password?: string } }>(
      `/api/vault/${encodeURIComponent(secret.id)}/reveal`,
      { method: 'POST' },
    )
    const value = payload.secret.apiKey || payload.secret.password || ''
    setRevealed(value)
    return value
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const path = secret ? `/api/vault/${encodeURIComponent(secret.id)}` : '/api/vault'
      await requestJson(path, {
        method: secret ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          kind,
          username,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(password.trim() ? { password: password.trim() } : {}),
        }),
      })
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有保存')
    }
  }

  const typed = kind === 'api-key' ? apiKey : password
  const visibleValue = showPlain ? revealed || typed : typed

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: 'contents' }}>
      <div className="card-hd">
        <h2>{secret ? `条目 · ${name || secret.name}` : '新建条目'}</h2>
        <div className="grow" />
        {secret ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void loadPlain()
                .then((value) => copyText(value))
                .then(() => {
                  setCopyNote('已复制')
                  setTimeout(() => setCopyNote(''), 1200)
                })
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '复制失败'))
            }}
          >
            {copyNote || '复制'}
          </button>
        ) : null}
      </div>
      <div className="card-bd">
        <div className="form">
          <div className="field-row">
            <div className="field">
              <label>名称<span className="req">*</span></label>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="field">
              <label>类型</label>
              <select value={kind} onChange={(event) => setKind(event.target.value === 'login' ? 'login' : 'api-key')}>
                <option value="api-key">API Key</option>
                <option value="login">登录（用户名 + 密码）</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>用户名（可选，列表可见）</label>
            <input value={username} placeholder="登录类条目填写" onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="field">
            <label>密钥 / 密码<span className="req">*</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                type={showPlain ? 'text' : 'password'}
                value={visibleValue}
                autoComplete="off"
                placeholder={secret ? '已保存，留空则不修改' : ''}
                onChange={(event) => {
                  const next = event.target.value
                  if (kind === 'api-key') setApiKey(next)
                  else setPassword(next)
                  if (showPlain) setRevealed(next)
                }}
                onBlur={hidePlain}
              />
              {secret ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    if (showPlain) {
                      hidePlain()
                      return
                    }
                    void loadPlain()
                      .then(() => {
                        setShowPlain(true)
                        if (timer.current) clearTimeout(timer.current)
                        timer.current = setTimeout(() => setShowPlain(false), REVEAL_VISIBLE_MS)
                      })
                      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '显示失败'))
                  }}
                >
                  {showPlain ? '隐藏' : '显示'}
                </button>
              ) : null}
            </div>
            <div className="help">明文约停留 8 秒后自动收起；点输入框外也会收起。落库为密文。</div>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
      <div className="card-ft">
        {secret ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginRight: 'auto', color: 'var(--danger)' }}
            onClick={() => {
              void requestJson(`/api/vault/${encodeURIComponent(secret.id)}`, { method: 'DELETE' }).then(() => onSaved())
            }}
          >
            删除
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn">
          保存
        </button>
      </div>
    </form>
  )
}
