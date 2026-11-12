/**
 * p0.9 分层记忆：三层面板 / 本回合注入来源条 / 写入 toast。
 * 摘要绿 · 长期蓝 · 工作灰；摘要 ≠ 长期。
 */

import { useEffect, useMemo } from 'react'
import type { LongTermMemory, MemoryInject, Message, Summary } from '../domain/types.ts'
import { requestJson, type ThreadLongTermMemories } from './api.ts'
import { formatShanghai } from './format.ts'
import { LtmPanel } from './ltm-panel.tsx'

export type MemWriteToastState = {
  text: string
  variant: 'summary' | 'ltm' | 'working'
} | null

export function MemWriteToast({
  toast,
  onDismiss,
}: {
  toast: MemWriteToastState
  onDismiss: () => void
}) {
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(onDismiss, 4200)
    return () => window.clearTimeout(timer)
  }, [toast, onDismiss])
  if (!toast) return null
  return (
    <div className={`mem-write-toast is-show is-${toast.variant}`} role="status" aria-live="polite">
      <span className="mem-write-icon" aria-hidden="true">
        ✓
      </span>
      <span className="mem-write-text">{toast.text}</span>
      <button type="button" className="mem-write-dismiss" aria-label="关闭" onClick={onDismiss}>
        ✕
      </button>
    </div>
  )
}

export function InjectSources({
  inject,
  summary,
  ltm,
  onPreview,
}: {
  inject: MemoryInject
  summary: Summary | null
  ltm: ThreadLongTermMemories | null
  onPreview: (source: 'working' | 'summary' | 'ltmFriend' | 'ltmProject') => void
}) {
  return (
    <div className="inject-sources" role="group" aria-label="本回合注入来源">
      <span className="inject-sources-label">本回合注入</span>
      <button
        type="button"
        className="inject-chip inject-chip-working"
        title="预览工作记忆"
        onClick={() => onPreview('working')}
      >
        工作 · {inject.workingCount}
      </button>
      <button
        type="button"
        className="inject-chip inject-chip-summary"
        title="预览会话摘要"
        onClick={() => onPreview('summary')}
      >
        摘要 · {inject.summary ? '开' : '关'}
      </button>
      {inject.ltmFriendCount > 0 ? (
        <button
          type="button"
          className="inject-chip inject-chip-ltm-friend"
          title="预览好友长期"
          onClick={() => onPreview('ltmFriend')}
        >
          长期 · {inject.ltmFriendCount} · 好友
        </button>
      ) : null}
      {inject.ltmProjectCount > 0 ? (
        <button
          type="button"
          className="inject-chip inject-chip-ltm-project"
          title="预览项目长期"
          onClick={() => onPreview('ltmProject')}
        >
          长期 · {inject.ltmProjectCount} · 项目
        </button>
      ) : null}
      {/* keep summary/ltm refs for a11y tooling */}
      <span hidden data-summary-on={summary?.injectOnNextTurn ? '1' : '0'} data-ltm={ltm?.injectable.length ?? 0} />
    </div>
  )
}

export function InjectPreview({
  source,
  summary,
  messages,
  ltm,
  inject,
  onClose,
}: {
  source: 'working' | 'summary' | 'ltmFriend' | 'ltmProject' | null
  summary: Summary | null
  messages: Message[]
  ltm: ThreadLongTermMemories | null
  inject: MemoryInject | null
  onClose: () => void
}) {
  if (!source) return null
  const title =
    source === 'working'
      ? '工作记忆'
      : source === 'summary'
        ? '事件摘要'
        : source === 'ltmFriend'
          ? '好友长期记忆'
          : '项目长期记忆'
  return (
    <div className="inject-preview" role="dialog" aria-label="注入来源预览">
      <div className="inject-preview-hd">
        <span className="inject-preview-title">{title}</span>
        <button type="button" className="panel-close" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="inject-preview-bd">
        {source === 'working' ? (
          <>
            <p className="inj-snip-meta">
              层 · working · 近 {inject?.workingCount ?? 0} 条 · 本会话近期发言（不跨会话）
            </p>
            <ul>
              {messages
                .filter((item) => item.role === 'user' || item.role === 'assistant')
                .filter((item) => item.status !== 'error' && item.kind !== 'assign' && item.kind !== 'result')
                .slice(-(inject?.workingCount || 6))
                .map((item) => (
                  <li key={item.id}>
                    {(item.role === 'user' ? '用户' : '助手') + '：' + item.content.trim().slice(0, 80)}
                  </li>
                ))}
            </ul>
          </>
        ) : null}
        {source === 'summary' ? (
          <>
            <p className="inj-snip-meta">
              层 · summary · injectOnNextTurn={summary?.injectOnNextTurn ? '开' : '关'} · 仅本会话 · ≠ 长期
            </p>
            {summary?.content ? (
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{summary.content}</pre>
            ) : (
              <p>本回合未注入会话摘要。</p>
            )}
          </>
        ) : null}
        {source === 'ltmFriend' ? (
          <LtmPreviewList
            rows={(ltm?.friend ?? []).filter((item) => inject?.ltmIds?.includes(item.id) ?? item.injectEnabled)}
            empty="本回合未注入好友长期。"
            scopeLabel="friend"
          />
        ) : null}
        {source === 'ltmProject' ? (
          <LtmPreviewList
            rows={(ltm?.project ?? []).filter((item) => inject?.ltmIds?.includes(item.id) ?? item.injectEnabled)}
            empty="本回合未注入项目长期。"
            scopeLabel="project"
          />
        ) : null}
      </div>
    </div>
  )
}

function LtmPreviewList({
  rows,
  empty,
  scopeLabel,
}: {
  rows: LongTermMemory[]
  empty: string
  scopeLabel: string
}) {
  if (rows.length === 0) return <p>{empty}</p>
  return (
    <>
      <p className="inj-snip-meta">层 · ltm · {scopeLabel} · 跨会话持久 · ≠ 会话摘要</p>
      <ul>
        {rows.map((item) => (
          <li key={item.id}>{item.fact}</li>
        ))}
      </ul>
    </>
  )
}

export function LayersPanel({
  layer,
  onLayer,
  summary,
  messages,
  ltm,
  friendName,
  projectName,
  pending,
  memoryInject,
  onClose,
  onGenerateSummary,
  onInjectSummary,
  onChanged,
  onToast,
}: {
  layer: 'working' | 'summary' | 'ltm'
  onLayer: (layer: 'working' | 'summary' | 'ltm') => void
  summary: Summary | null
  messages: Message[]
  ltm: ThreadLongTermMemories | null
  friendName: string
  projectName: string
  pending: boolean
  memoryInject: MemoryInject | null
  onClose: () => void
  onGenerateSummary: () => void
  onInjectSummary: () => void
  onChanged: () => Promise<void>
  onToast: (toast: MemWriteToastState) => void
}) {
  const working = useMemo(
    () =>
      messages
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .filter((item) => item.status !== 'error' && item.kind !== 'assign' && item.kind !== 'result')
        .slice(-(memoryInject?.workingCount || 8)),
    [messages, memoryInject?.workingCount],
  )
  const when = summary ? formatShanghai(summary.updatedAt) : ''

  async function promoteToLtm() {
    if (!summary?.content.trim()) return
    if (!ltm?.friendOwnerId) {
      onToast({ text: '没有可挂载的好友，未写入长期', variant: 'working' })
      return
    }
    if (!window.confirm('把当前会话摘要要点升为好友长期记忆？确认后写入，可在「长期」页管理。')) return
    const fact = summary.content.trim().slice(0, 500)
    await requestJson('/api/long-term-memories', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'friend',
        ownerId: ltm.friendOwnerId,
        fact,
        source: 'manual',
      }),
    })
    await onChanged()
    onToast({ text: '已写入好友长期记忆', variant: 'ltm' })
    onLayer('ltm')
  }

  return (
    <div className="summary-panel layers-panel is-open" role="dialog" aria-label="分层记忆">
      <div className="summary-panel-hd">
        <h3>记忆</h3>
        <span className="tag">分层可感知</span>
        <button type="button" className="panel-close" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="layer-tabs" role="tablist" aria-label="记忆层">
        {(
          [
            ['working', '工作'],
            ['summary', '摘要'],
            ['ltm', '长期'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={layer === id ? 'layer-tab is-active' : 'layer-tab'}
            aria-selected={layer === id}
            onClick={() => onLayer(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="summary-panel-bd">
        {layer === 'working' ? (
          <div className="layer-pane" data-pane="working">
            <p className="ltm-help">
              本会话近期发言，作为模型上下文。<strong>不跨会话</strong>；与绿摘要 / 蓝长期分开。
            </p>
            <div className="working-list inset-group">
              {working.length === 0 ? (
                <div className="working-item">
                  <div className="working-title">还没有可计入的发言</div>
                  <div className="working-meta">工作记忆 · 空</div>
                </div>
              ) : (
                working.map((item) => (
                  <div key={item.id} className="working-item">
                    <div className="working-title">
                      {(item.role === 'user' ? '用户' : '助手') + '：' + item.content.trim().slice(0, 120)}
                    </div>
                    <div className="working-meta">工作记忆 · 本会话</div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
        {layer === 'summary' ? (
          <div className="layer-pane" data-pane="summary">
            <div className="summary-meta">
              <span>{summary ? `${summary.source === 'manual' ? '手动生成' : '自动生成'} · ${when}` : '还没有摘要'}</span>
              {summary?.injectOnNextTurn ? <span className="tag tag-ok">写入记忆</span> : <span className="tag">尚未注入</span>}
              <span className="tag">仅本会话</span>
              <span className="tag">≤1000 字硬顶</span>
            </div>
            <p className="ltm-help" style={{ margin: '0 0 8px' }}>
              <strong>会话摘要 · 事件</strong> — 增量改写事件，非原文拼接。摘要 ≠ 长期。
            </p>
            <div className="summary-body">
              {summary ? (
                <p style={{ whiteSpace: 'pre-wrap' }}>{summary.content}</p>
              ) : (
                <p>点「手动生成摘要」，把这段对话收成事件摘要。摘要 ≠ 长期记忆。</p>
              )}
            </div>
            <div className="layer-pane-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={pending || !summary?.content}
                title="确认后门闩写入好友长期"
                onClick={() => void promoteToLtm()}
              >
                升为长期…
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={onGenerateSummary}>
                手动生成摘要
              </button>
              {summary && !summary.injectOnNextTurn ? (
                <button type="button" className="btn btn-sm" disabled={pending} onClick={onInjectSummary}>
                  保留并注入
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {layer === 'ltm' && ltm ? (
          <div className="layer-pane" data-pane="ltm">
            <p className="ltm-help">
              挂在<strong>好友</strong>或<strong>项目/群</strong>上，跨会话注入。<strong>≠</strong> 会话摘要。
            </p>
            <LtmPanel
              bundle={ltm}
              friendName={friendName}
              projectName={projectName}
              onClose={onClose}
              onChanged={onChanged}
              onWrote={() => onToast({ text: '已写入好友长期记忆', variant: 'ltm' })}
              embedded
            />
          </div>
        ) : null}
      </div>
      <div className="summary-panel-ft">
        <span className="hint" style={{ fontSize: 11, color: 'var(--muted)' }}>
          工作灰 · 摘要绿 · 长期蓝
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  )
}
