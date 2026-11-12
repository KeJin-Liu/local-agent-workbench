/**
 * p1.1：写文件 / shell 确认卡 + 工具时间线（对齐 agent-chat-ui 四稿）。
 */
import { useState } from 'react'
import type { CodeAction, CodeToolTimelineEntry } from '../domain/types.ts'
import { requestJson } from './api.ts'

function draftString(draft: Record<string, unknown>, key: string): string {
  const value = draft[key]
  return typeof value === 'string' ? value : ''
}

function colorizeDiff(text: string): { className: string; text: string }[] {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return { className: 'diff-meta', text: line }
    if (line.startsWith('@@')) return { className: 'diff-hunk', text: line }
    if (line.startsWith('+')) return { className: 'diff-add', text: line }
    if (line.startsWith('-')) return { className: 'diff-del', text: line }
    return { className: 'diff-ctx', text: line }
  })
}

export function CodeActionCard({ action, onDone }: { action: CodeAction; onDone: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(action.error ?? '')
  const [phase, setPhase] = useState<'pending' | 'confirmed' | 'cancelled' | 'failed'>(
    action.status === 'pending' ? 'pending' : action.status,
  )
  const [result, setResult] = useState<Record<string, unknown> | undefined>(action.result)

  async function confirm() {
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; action: CodeAction }>(
        `/api/code-actions/${encodeURIComponent(action.id)}/confirm`,
        { method: 'POST' },
      )
      setResult(payload.action.result)
      setPhase('confirmed')
      window.setTimeout(() => onDone(), 700)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认失败，可以再试一次')
      setPhase('failed')
    } finally {
      setPending(false)
    }
  }

  async function cancel() {
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/code-actions/${encodeURIComponent(action.id)}/cancel`, { method: 'POST' })
      setPhase('cancelled')
      window.setTimeout(() => onDone(), 700)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败')
    } finally {
      setPending(false)
    }
  }

  if (action.kind === 'write') {
    const relativePath = draftString(action.draft, 'relativePath') || '文件'
    const unifiedDiff = draftString(action.draft, 'unifiedDiff')
    const done = phase === 'confirmed'
    const cancelled = phase === 'cancelled'
    return (
      <div
        className={`confirm-card code-diff${done ? ' is-done' : ''}${cancelled ? ' is-cancelled' : ''}${phase === 'failed' ? ' is-failed' : ''}`}
        role="group"
        aria-label="确认写入"
        data-status={phase}
      >
        <div className="confirm-card-hd">
          <div className="cc-icon">📝</div>
          <div>
            <div className="cc-kind">写文件</div>
            <div className="cc-title">{done ? '已写入' : cancelled ? '已取消' : phase === 'failed' ? '写入失败' : '确认写入'}</div>
            <div className="cc-sub">
              {relativePath} · Workspace 内 · {done ? '已落盘' : cancelled ? '草稿已丢弃' : '确认前磁盘不变'}
            </div>
          </div>
        </div>
        <div className="confirm-card-bd">
          <div className="inset-section-title">将修改</div>
          <ul className="code-file-list">
            <li>
              <code>{relativePath}</code>
              <span className="tag">{done ? '已写入' : 'pending'}</span>
            </li>
          </ul>
          {unifiedDiff ? (
            <>
              <div className="inset-section-title">Unified diff</div>
              <pre className="code-diff-preview" tabIndex={0}>
                {colorizeDiff(unifiedDiff).map((line, index) => (
                  <div key={`${index}-${line.text.slice(0, 12)}`} className={line.className}>
                    {line.text || ' '}
                  </div>
                ))}
              </pre>
            </>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <p className="confirm-note">CodeAction status={phase} · 确认前不落盘 · workbench_fs_write</p>
        </div>
        {phase === 'pending' || phase === 'failed' ? (
          <div className="confirm-card-ft">
            <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void cancel()}>
              取消
            </button>
            <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void confirm()}>
              {pending ? '写入中…' : '确认写入'}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (action.kind === 'delete') {
    const relativePath = draftString(action.draft, 'relativePath') || '文件'
    const done = phase === 'confirmed'
    const cancelled = phase === 'cancelled'
    return (
      <div
        className={`confirm-card code-diff${done ? ' is-done' : ''}${cancelled ? ' is-cancelled' : ''}${phase === 'failed' ? ' is-failed' : ''}`}
        role="group"
        aria-label="确认删除"
        data-status={phase}
      >
        <div className="confirm-card-hd">
          <div className="cc-icon">删</div>
          <div>
            <div className="cc-kind">删除</div>
            <div className="cc-title">{done ? '已删除' : cancelled ? '已取消' : phase === 'failed' ? '删除失败' : '确认删除'}</div>
            <div className="cc-sub">
              {relativePath} · Workspace 内 · {done ? '已删除' : cancelled ? '未删除' : '确认前不会删除'}
            </div>
          </div>
        </div>
        <div className="confirm-card-bd">
          {error ? <p className="form-error">{error}</p> : null}
          <p className="confirm-note">只删除这一个文件或空目录 · 确认前磁盘不变 · workbench_fs_delete</p>
        </div>
        {phase === 'pending' || phase === 'failed' ? (
          <div className="confirm-card-ft">
            <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void cancel()}>
              取消
            </button>
            <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void confirm()}>
              {pending ? '删除中…' : '确认删除'}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const command = draftString(action.draft, 'command')
  const cwd = draftString(action.draft, 'cwd')
  const timeoutMs = typeof action.draft.timeoutMs === 'number' ? action.draft.timeoutMs : 60_000
  const done = phase === 'confirmed'
  const cancelled = phase === 'cancelled'
  const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null
  const stdoutTail = result && typeof result.stdoutTail === 'string' ? result.stdoutTail : ''
  const stderrTail = result && typeof result.stderrTail === 'string' ? result.stderrTail : ''
  const timedOut = Boolean(result?.timedOut)
  const logText = [stdoutTail, stderrTail].filter(Boolean).join('\n').trim()

  return (
    <div
      className={`confirm-card code-shell${done ? ' is-done' : ''}${cancelled ? ' is-cancelled' : ''}${phase === 'failed' ? ' is-failed' : ''}`}
      role="group"
      aria-label="批准命令"
      data-status={phase}
    >
      <div className="confirm-card-hd">
        <div className="cc-icon">⌘</div>
        <div>
          <div className="cc-kind">Shell</div>
          <div className="cc-title">{done ? '已执行' : cancelled ? '已拒绝' : phase === 'failed' ? '执行失败' : '批准执行命令'}</div>
          <div className="cc-sub">
            cwd = 工作目录 · 超时 {Math.round(timeoutMs / 1000)}s · {done ? '已回传' : '批准前不执行'}
          </div>
        </div>
      </div>
      <div className="confirm-card-bd">
        <div className="inset-section-title">命令</div>
        <pre className="code-shell-cmd">{command}</pre>
        <div className="inset-group code-shell-meta">
          <div className="inset-row">
            <span>cwd</span>
            <code title={cwd}>{cwd}</code>
          </div>
          <div className="inset-row">
            <span>超时</span>
            <span>{Math.round(timeoutMs / 1000)} 秒（超时终止并回传已有日志）</span>
          </div>
        </div>
        {done ? (
          <div className="code-shell-result">
            <div className="inset-section-title">结果</div>
            <div className="code-shell-exit">
              <span className={exitCode === 0 && !timedOut ? 'tag tag-ok' : 'tag tag-warn'}>
                {timedOut ? '超时' : `exit ${exitCode ?? '?'}`}
              </span>
            </div>
            {logText ? <pre className="code-shell-log">{logText}</pre> : <p className="confirm-note">无输出</p>}
          </div>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <p className="confirm-note">CodeAction kind=shell · pending 不执行 · workbench_shell</p>
      </div>
      {phase === 'pending' || phase === 'failed' ? (
        <div className="confirm-card-ft">
          <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void cancel()}>
            拒绝
          </button>
          <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void confirm()}>
            {pending ? '执行中…' : '批准'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function toolKind(toolName: string, outcome: string): string {
  if (outcome === 'denied' || outcome === 'error') return 'oob'
  if (toolName.includes('shell')) return 'shell'
  if (toolName.includes('delete')) return 'delete'
  if (toolName.includes('write')) return 'write'
  return 'read'
}

function outcomeLabel(outcome: CodeToolTimelineEntry['outcome']): { text: string; ok: boolean } {
  switch (outcome) {
    case 'ok':
      return { text: '自动', ok: true }
    case 'pending':
      return { text: '待确认', ok: true }
    case 'confirmed':
      return { text: '已确认', ok: true }
    case 'cancelled':
      return { text: '已取消', ok: false }
    case 'denied':
      return { text: '已拒绝', ok: false }
    case 'error':
      return { text: '错误', ok: false }
    default:
      return { text: outcome, ok: false }
  }
}

export function CodeToolTimeline({ events }: { events: CodeToolTimelineEntry[] }) {
  /** 历史回看默认收起，避免多回合工具轨迹堆成一长条。 */
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  const summaryParts = new Set<string>()
  for (const event of events) {
    if (event.toolName.includes('read') || event.toolName.includes('list') || event.toolName.includes('grep')) {
      summaryParts.add('读')
    } else if (event.toolName.includes('delete')) {
      summaryParts.add('删')
    } else if (event.toolName.includes('write')) {
      summaryParts.add('写')
    } else if (event.toolName.includes('shell')) {
      summaryParts.add('shell')
    }
  }
  return (
    <div className={`tool-timeline${open ? ' is-open' : ''}`} data-open={open ? '1' : '0'}>
      <button
        type="button"
        className="tool-timeline-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tt-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tt-label">工具时间线</span>
        <span className="tag">{events.length}</span>
        <span className="tt-summary">{[...summaryParts].join(' · ') || '工具调用'}</span>
      </button>
      <div className="tool-timeline-body" role="list">
        {events.map((event) => {
          const kind = toolKind(event.toolName, event.outcome)
          const label = outcomeLabel(event.outcome)
          return (
            <div
              key={event.id}
              className={`tt-item${event.outcome === 'cancelled' || event.outcome === 'denied' ? ' tt-item-muted' : ''}`}
              role="listitem"
              data-kind={kind}
            >
              <div className="tt-icon" aria-hidden="true">
                {kind === 'shell' ? '⌘' : kind === 'delete' ? '删' : kind === 'write' ? '📝' : kind === 'oob' ? '🚫' : '👁'}
              </div>
              <div className="tt-main">
                <div className="tt-row1">
                  <span className="tt-name">{event.toolName}</span>
                  <span className={label.ok ? 'tag tag-ok' : 'tag tag-warn'}>{label.text}</span>
                </div>
                <div className="tt-row2">
                  <code>{event.detail || '—'}</code>
                </div>
                {event.resultSummary ? <div className="tt-result">{event.resultSummary}</div> : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function workspaceChipLabel(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '未设工作目录'
  const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean)
  const base = parts[parts.length - 1] || trimmed
  return `工作目录 · ${base}`
}
