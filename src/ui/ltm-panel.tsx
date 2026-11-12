/**
 * 好友 / 项目长期记忆管理面板。蓝色视觉，与绿色会话摘要区分。
 */

import { useMemo, useState } from 'react'
import type { LongTermMemory, LongTermMemoryScope } from '../domain/types.ts'
import { requestJson, type ThreadLongTermMemories } from './api.ts'
import { formatShanghai } from './format.ts'

export function LtmChipBanner({
  bundle,
  onOpen,
}: {
  bundle: ThreadLongTermMemories | null
  onOpen: () => void
}) {
  const count = bundle?.injectable.length ?? 0
  if (!bundle || count === 0) return null
  const label =
    bundle.friendCount > 0 && bundle.projectCount === 0
      ? '已注入好友长期记忆'
      : bundle.projectCount > 0 && bundle.friendCount === 0
        ? '已注入项目长期记忆'
        : '已注入长期记忆'
  return (
    <>
      <button type="button" className="chip chip-ltm" title="跨会话持久；与会话摘要不同" onClick={onOpen}>
        <span className="dot" aria-hidden="true" />
        长期记忆 · {count}
      </button>
      {/* banner rendered by parent in chat body via same label helpers */}
      <span hidden data-ltm-label={label} data-ltm-count={count} />
    </>
  )
}

export function LtmBanner({
  bundle,
  onOpen,
}: {
  bundle: ThreadLongTermMemories | null
  onOpen: () => void
}) {
  const count = bundle?.injectable.length ?? 0
  if (!bundle || count === 0) return null
  const label =
    bundle.friendCount > 0 && bundle.projectCount === 0
      ? '已注入好友长期记忆'
      : bundle.projectCount > 0 && bundle.friendCount === 0
        ? '已注入项目长期记忆'
        : '已注入长期记忆'
  return (
    <div className="memory-banner memory-banner-ltm" role="status">
      <span className="dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
      <span>
        <strong>{label}</strong>（{count} 条）· 与会话摘要分开
      </span>
      <button type="button" className="linkish" onClick={onOpen}>
        管理
      </button>
    </div>
  )
}

export function LtmPanel({
  bundle,
  friendName,
  projectName,
  onClose,
  onChanged,
  embedded = false,
  onWrote,
}: {
  bundle: ThreadLongTermMemories
  friendName: string
  projectName: string
  onClose: () => void
  onChanged: () => Promise<void>
  /** 嵌在分层面板里时去掉外框 */
  embedded?: boolean
  onWrote?: () => void
}) {
  const defaultScope: LongTermMemoryScope = bundle.projectOwnerId && !bundle.friendOwnerId ? 'project' : 'friend'
  const [scope, setScope] = useState<LongTermMemoryScope>(defaultScope)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const ownerId = scope === 'friend' ? bundle.friendOwnerId : bundle.projectOwnerId
  const memories = scope === 'friend' ? bundle.friend : bundle.project
  const injectEnabled = scope === 'friend' ? bundle.friendInjectEnabled : bundle.projectInjectEnabled
  const scopeLabel = useMemo(() => {
    const name = scope === 'friend' ? friendName || '好友' : projectName || '项目/群'
    return `${name} · ${memories.length} 条`
  }, [scope, friendName, projectName, memories.length])

  async function refresh() {
    await onChanged()
  }

  async function addMemory() {
    if (!ownerId) {
      setError(scope === 'project' ? '当前不是群聊，无法写项目记忆。' : '没有好友。')
      return
    }
    const fact = window.prompt('添加一条长期记忆事实：')
    if (!fact?.trim()) return
    setPending(true)
    setError('')
    try {
      await requestJson('/api/long-term-memories', {
        method: 'POST',
        body: JSON.stringify({ scope, ownerId, fact: fact.trim(), source: 'manual' }),
      })
      await refresh()
      onWrote?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有添加')
    } finally {
      setPending(false)
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/long-term-memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有更新')
    } finally {
      setPending(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除这条长期记忆？')) return
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/long-term-memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有删除')
    } finally {
      setPending(false)
    }
  }

  async function toggleScopeInject(next: boolean) {
    if (!ownerId) return
    setPending(true)
    setError('')
    try {
      await requestJson('/api/long-term-memories/inject-pref', {
        method: 'POST',
        body: JSON.stringify({ scope, ownerId, injectEnabled: next }),
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有更新注入开关')
    } finally {
      setPending(false)
    }
  }

  const body = (
    <>
      {embedded ? null : (
        <p className="ltm-help">
          挂在<strong>好友</strong>或<strong>项目/群</strong>上的持久事实，跨会话注入。与「会话摘要」不同：摘要只服务当前会话。
        </p>
      )}
      <div className="session-tabs ltm-scope" role="tablist" aria-label="记忆作用域" style={{ margin: embedded ? '0 0 10px' : '10px 0 12px' }}>
        <button
          className={scope === 'friend' ? 'session-tab is-active' : 'session-tab'}
          type="button"
          role="tab"
          aria-selected={scope === 'friend'}
          onClick={() => setScope('friend')}
        >
          好友
        </button>
        <button
          className={scope === 'project' ? 'session-tab is-active' : 'session-tab'}
          type="button"
          role="tab"
          aria-selected={scope === 'project'}
          onClick={() => setScope('project')}
        >
          项目/群
        </button>
      </div>
      <div className="ltm-scope-label">{scopeLabel}</div>
      {!ownerId ? (
        <p className="help">{scope === 'project' ? '在群聊里才能管理项目/群长期记忆。' : '没有可挂靠的好友。'}</p>
      ) : (
        <div className="inset-group ltm-list" style={{ marginBottom: 10 }}>
          {memories.length === 0 ? <p className="help">还没有条目。点「＋ 添加」写入一条。</p> : null}
          {memories.map((item) => (
            <MemoryItem
              key={item.id}
              item={item}
              disabled={pending}
              onToggleInject={(value) => void patch(item.id, { injectEnabled: value })}
              onEdit={() => {
                const next = window.prompt('编辑长期记忆：', item.fact)
                if (next == null) return
                void patch(item.id, { fact: next })
              }}
              onDelete={() => void remove(item.id)}
            />
          ))}
        </div>
      )}
      {ownerId ? (
        <div className="inset-row" style={{ justifyContent: 'space-between', padding: '8px 12px', marginBottom: 4 }}>
          <span style={{ fontSize: 13 }}>全局注入后续回合</span>
          <label className="switch" title="关闭后本作用域记忆不再注入">
            <input
              type="checkbox"
              checked={injectEnabled}
              disabled={pending}
              onChange={(event) => void toggleScopeInject(event.target.checked)}
            />
            <span className="switch-ui" />
          </label>
        </div>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className={embedded ? 'layer-pane-actions' : 'summary-panel-ft'} style={embedded ? { marginTop: 10 } : undefined}>
        <button className="btn btn-secondary btn-sm" type="button" disabled={pending || !ownerId} onClick={() => void addMemory()}>
          ＋ 添加
        </button>
        {embedded ? null : (
          <button className="btn btn-sm" type="button" onClick={onClose}>
            完成
          </button>
        )}
      </div>
    </>
  )

  if (embedded) return <div className="ltm-embedded">{body}</div>

  return (
    <div className="summary-panel ltm-panel is-open" role="dialog" aria-label="长期记忆">
      <div className="summary-panel-hd">
        <h3>长期记忆</h3>
        <span className="tag">跨会话</span>
        <button className="panel-close" type="button" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="summary-panel-bd">{body}</div>
    </div>
  )

}

function MemoryItem({
  item,
  disabled,
  onToggleInject,
  onEdit,
  onDelete,
}: {
  item: LongTermMemory
  disabled?: boolean
  onToggleInject: (value: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="ltm-item">
      <div className="ltm-item-main">
        <div className="ltm-title">{item.fact}</div>
        <div className="ltm-meta">
          <span className={item.source === 'auto' ? 'tag tag-ok' : 'tag'}>{item.source === 'auto' ? '自动提炼' : '手动添加'}</span>
          {' · '}
          {formatShanghai(item.updatedAt)}
          {item.pinned ? (
            <>
              {' · '}
              <span className="ltm-pin">已置顶</span>
            </>
          ) : null}
        </div>
      </div>
      <label className="ltm-inject" title="注入后续回合">
        <input
          type="checkbox"
          checked={item.injectEnabled}
          disabled={disabled}
          onChange={(event) => onToggleInject(event.target.checked)}
        />{' '}
        注入
      </label>
      <div className="ltm-actions">
        <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={onEdit}>
          编辑
        </button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  )
}
