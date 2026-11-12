/**
 * 提供方列表。本地和云端都走同一套 OpenAI 兼容字段。密钥输入框不回显原文。
 */

import { useState, type FormEvent } from 'react'
import type { PublicProvider, PublicSecret } from '../domain/types.ts'
import { probeModels, requestJson, type ProbePayload } from './api.ts'
import { applyProbeModelsToFormState } from './provider-probe-form.ts'

type Draft = {
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
  enabled: boolean
  hasApiKey: boolean
  vaultEntryId: string
  defaultModel: string
  probedModels: string[]
}


function humanProbeMessage(probe: Extract<ProbePayload, { ok: false }>): string {
  const raw = `${probe.message}${probe.hint ? ` ${probe.hint}` : ''}`
  if (/CORS|OLLAMA_ORIGINS|vaultEntryId|Node 进程/i.test(raw)) {
    return '连不上这个地址。请确认本机模型服务已启动，保存后再点「探测模型」。'
  }
  if (probe.status === 401 || probe.status === 403) {
    return '服务拒绝了访问。请填好密钥后再探测。本地 Ollama 通常不用填。'
  }
  if (probe.status === 404) {
    return '没有找到模型列表。请确认地址以 /v1 结尾后再试。'
  }
  return probe.hint ? `${probe.message} ${probe.hint}` : probe.message
}

export function ProviderSettings({
  providers,
  secrets,
  onSaved,
  onBack,
}: {
  providers: PublicProvider[]
  secrets: PublicSecret[]
  onSaved: () => Promise<void>
  onBack?: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(providers[0]?.id ?? null)
  const selected = providers.find((item) => item.id === selectedId) ?? null
  const [creating, setCreating] = useState(false)

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">模型提供方</div>
          <div className="page-sub">Ollama / LM Studio / OpenAI / DeepSeek / 阿里云百炼 / Cursor · Base URL · 密钥走保险库 · 探测不清 Key</div>
        </div>
        <div className="grow" />
        {onBack ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            ← 设置
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setCreating(true)
            setSelectedId(null)
          }}
        >
          ＋ 添加
        </button>
      </header>
      <div className="page-bd">
        <div className="page-layout">
          <section className="card">
            <div className="card-hd">
              <h2>提供方列表</h2>
            </div>
            <div className="card-bd provider-list">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={provider.id === selectedId && !creating ? 'list-item is-active' : 'list-item'}
                  style={!provider.enabled ? { opacity: 0.55 } : undefined}
                  onClick={() => {
                    setCreating(false)
                    setSelectedId(provider.id)
                  }}
                >
                  <span className={provider.enabled ? 'status-dot on' : 'status-dot'} />
                  <span className="list-item-meta">
                    <span className="list-item-title">{provider.name}</span>
                    <span className="list-item-desc">
                      {provider.baseUrl}
                      {' · '}
                      {provider.defaultModel || (provider.enabled ? '尚未指定模型' : '停用')}
                    </span>
                  </span>
                  <span className={provider.enabled ? 'tag tag-ok' : 'tag tag-off'}>{provider.enabled ? '启用' : '停用'}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            {creating ? (
              <ProviderForm
                secrets={secrets}
                key="new"
                draft={{
                  name: '',
                  baseUrl: 'http://127.0.0.1:11434/v1',
                  apiKey: '',
                  clearApiKey: false,
                  enabled: true,
                  hasApiKey: false,
                  vaultEntryId: '',
                  defaultModel: '',
                  probedModels: [],
                }}
                onSaved={async () => {
                  setCreating(false)
                  await onSaved()
                }}
                onCancel={() => setCreating(false)}
              />
            ) : selected ? (
              <ProviderForm
                secrets={secrets}
                /* p1.3.2: key 只跟提供方 id。探测会改 updatedAt/probedModels，若写进 key 会 remount 并清空本轮已填 API Key。 */
                key={selected.id}
                draft={{
                  id: selected.id,
                  name: selected.name,
                  baseUrl: selected.baseUrl,
                  apiKey: '',
                  clearApiKey: false,
                  enabled: selected.enabled,
                  hasApiKey: Boolean(selected.vaultEntryId),
                  vaultEntryId: selected.vaultEntryId ?? '',
                  defaultModel: selected.defaultModel ?? '',
                  probedModels: selected.probedModels ?? [],
                }}
                onSaved={onSaved}
              />
            ) : (
              <p className="empty">还没有提供方。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function ProviderForm({
  draft,
  secrets,
  onSaved,
  onCancel,
}: {
  draft: Draft
  secrets: PublicSecret[]
  onSaved: () => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(draft.name)
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [enabled, setEnabled] = useState(draft.enabled)
  const [vaultEntryId, setVaultEntryId] = useState(draft.vaultEntryId)
  const [defaultModel, setDefaultModel] = useState(draft.defaultModel)
  const [probedModels, setProbedModels] = useState<string[]>(draft.probedModels)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [probe, setProbe] = useState<ProbePayload | { phase: 'loading' } | null>(null)

  async function onSave(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const path = draft.id ? `/api/providers/${encodeURIComponent(draft.id)}` : '/api/providers'
      const saved = await requestJson<{ ok: true; provider: PublicProvider }>(path, {
        method: draft.id ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          baseUrl,
          enabled,
          defaultModel,
          ...(defaultModel.trim() ? {} : { clearDefaultModel: true }),
          probedModels,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          // 仅取消关联或主动清空引用时 clear；无 Key 的 Ollama 保存不要盲目 clearSecret。
          ...(clearApiKey || (!vaultEntryId && draft.hasApiKey)
            ? { clearSecret: true }
            : vaultEntryId
              ? { vaultEntryId }
              : {}),
        }),
      })
      // 保存后才清本轮明文；并从响应同步 vault，避免未 remount 时二次保存误 clearSecret。
      setApiKey('')
      setClearApiKey(false)
      setVaultEntryId(saved.provider.vaultEntryId ?? '')
      setSaved(true)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有保存')
    } finally {
      setSaving(false)
    }
  }

  async function onProbe() {
    setProbe({ phase: 'loading' })
    setError('')
    try {
      const typed = clearApiKey ? '' : apiKey.trim()
      const result = draft.id
        ? await probeModels({ baseUrl, apiKey: typed || undefined, providerId: draft.id })
        : await probeModels({ baseUrl, apiKey: typed || undefined })
      setProbe(result)
      if (result.ok) {
        // p1.3.2: 探测只刷新本表模型列表；不 onSaved、不 remount、不清 apiKey/保险库/Base URL。
        const next = applyProbeModelsToFormState(
          {
            apiKey,
            clearApiKey,
            vaultEntryId,
            baseUrl,
            name,
            enabled,
            defaultModel,
            probedModels,
          },
          result.models.map((item) => item.id),
        )
        setProbedModels(next.probedModels)
        setDefaultModel(next.defaultModel)
        // 显式保留：apiKey / clearApiKey / vaultEntryId / baseUrl / name / enabled 均不 set
      }
    } catch (cause) {
      setProbe({ ok: false, message: cause instanceof Error ? cause.message : '探测失败', elapsedMs: 0 })
    }
  }

  return (
    <form onSubmit={(event) => void onSave(event)} style={{ display: 'contents' }}>
      <div className="card-hd">
        <h2>{draft.id ? `编辑 · ${name || '提供方'}` : '新建提供方'}</h2>
        <div className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(probe && 'phase' in probe)} onClick={() => void onProbe()}>
          {probe && 'phase' in probe ? '探测中' : '探测模型'}
        </button>
      </div>
      <div className="card-bd">
        <p className="probe-keep-help">
          探测只刷新模型列表，不会清空 API Key / 保险库引用 / Base URL。
        </p>
        <div className="form">
          <div className="field-row">
            <div className="field">
              <label>名称<span className="req">*</span></label>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
              />
            </div>
            <div className="field">
              <label>启用</label>
              <button
                type="button"
                className={enabled ? 'toggle is-on' : 'toggle'}
                aria-pressed={enabled}
                onClick={() => {
                  setEnabled((value) => !value)
                  setSaved(false)
                }}
              />
            </div>
          </div>
          <div className="field">
            <label>Base URL<span className="req">*</span></label>
            <input
              value={baseUrl}
              spellCheck={false}
              onChange={(event) => {
                setBaseUrl(event.target.value)
                setSaved(false)
                setProbe(null)
              }}
            />
            <span className="help">
              须以 /v1 结尾，不要写成 /v1/models。
              {draft.id === 'cursor'
                ? ' 探测读取官方模型目录。发送时用同一把 Key 创建一次无仓库的 Cloud Agent 来回复，不走 /chat/completions。'
                : ''}
            </span>
          </div>
          <div className="field-row">
            <div className="field">
              <label>默认模型</label>
              <input
                value={defaultModel}
                spellCheck={false}
                placeholder="探测后点选，或手动填写"
                onChange={(event) => {
                  setDefaultModel(event.target.value)
                  setSaved(false)
                }}
              />
            </div>
          </div>
          <div className="field">
            <label>API Key（粘贴后写入保险库）</label>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={draft.hasApiKey && !clearApiKey ? '已关联，留空则不修改' : '本轮输入的 Key，探测后仍保留'}
              onChange={(event) => {
                setApiKey(event.target.value)
                setSaved(false)
              }}
            />
            <span className="help">密钥可走保险库引用；本轮刚输入的明文探测后仍留在输入框。已保存原文不回显（保险库规则不变）。</span>
          </div>
          <div className="field">
            <label>保险库引用</label>
            <select
              value={vaultEntryId}
              onChange={(event) => {
                setVaultEntryId(event.target.value)
                setSaved(false)
              }}
            >
              <option value="">不使用保险库</option>
              {secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
          </div>
          {draft.hasApiKey ? (
            <label className="check">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(event) => {
                  setClearApiKey(event.target.checked)
                  setSaved(false)
                }}
              />
              取消关联保险库
            </label>
          ) : null}
          <div className="field">
            <label>已探测模型（点选设为默认）</label>
            {probedModels.length === 0 ? (
              <p className="hint">还没有列表。点右上角「探测模型」拉取。</p>
            ) : (
              <div className="provider-list" style={{ padding: 0 }}>
                {probedModels.map((id) => {
                  const selected = defaultModel === id
                  return (
                    <button
                      key={id}
                      type="button"
                      className={selected ? 'list-item is-active' : 'list-item'}
                      style={{ margin: '3px 0' }}
                      onClick={() => {
                        setDefaultModel(id)
                        setSaved(false)
                      }}
                    >
                      <span className="check" style={{ color: 'var(--accent)', width: 16 }}>
                        {selected ? '✓' : ''}
                      </span>
                      <span className="list-item-meta">
                        <span className="list-item-title">{id}</span>
                        <span className="list-item-desc">{selected ? '默认模型' : '可选用'}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          {saved ? <p className="form-ok">已保存到本地库。</p> : null}
          <ProbeView probe={probe} />
        </div>
      </div>
      <div className="card-ft">
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
        ) : null}
        <button type="submit" className="btn" disabled={saving}>
          {saving ? '保存中' : '保存'}
        </button>
      </div>
    </form>
  )
}

function ProbeView({ probe }: { probe: ProbePayload | { phase: 'loading' } | null }) {
  if (!probe) return null
  if ('phase' in probe) return <p className="hint">正在请求模型列表…</p>
  if (!probe.ok) {
    const tech = [
      probe.message,
      probe.hint,
      probe.status != null ? `HTTP ${probe.status}` : '',
      `elapsed ${probe.elapsedMs} ms`,
    ]
      .filter(Boolean)
      .join('\n')
    return (
      <div className="probe-error" role="alert">
        <div className="probe-error-title">探测失败：连不上该地址</div>
        <div className="probe-error-desc">
          {humanProbeMessage(probe)} 表单里的 API Key / 保险库引用 / Base URL 不会被清空。
        </div>
        <details>
          <summary>技术详情（可选）</summary>
          <pre>{tech}</pre>
        </details>
      </div>
    )
  }
  return (
    <div className="probe-status" aria-live="polite">
      <span className="tag tag-ok">已刷新模型列表</span>
      <span className="probe-status-note">
        找到 {probe.models.length} 个 · {probe.elapsedMs} ms · 表单凭证未改动
      </span>
    </div>
  )
}
