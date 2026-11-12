/**
 * 自动化任务：列表、inset 编辑、立即运行和历史。
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { AutomationTask, ConversationCard, Friend } from '../domain/types.ts'
import { MAIL_POLL_TASK_ID, MAIL_SYSTEM_DESCRIPTION } from '../domain/mail-constants.ts'
import { requestJson } from './api.ts'
import { nextCronTime } from '../app/cron.ts'

function isSystemMailTask(task: AutomationTask | null | undefined): boolean {
  return Boolean(task && (task.id === MAIL_POLL_TASK_ID || task.kind === 'system_mail_poll'))
}

export function TasksPage({ friends, conversations, onOpenMail }: { friends: Friend[]; conversations: ConversationCard[]; onOpenMail?: () => void }) {
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null)
  const [error, setError] = useState('')

  async function reload() {
    const payload = await requestJson<{ ok: true; tasks: AutomationTask[] }>('/api/tasks')
    setTasks(payload.tasks)
    return payload.tasks
  }

  useEffect(() => {
    void reload()
      .then((list) => setSelectedId((current) => current ?? list[0]?.id ?? null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '读不到任务'))
  }, [])

  // 定时任务在后台跑，页面开着时每 10 秒刷新一次状态和历史。
  useEffect(() => {
    const timer = setInterval(() => {
      void requestJson<{ ok: true; tasks: AutomationTask[] }>('/api/tasks')
        .then((payload) => setTasks(payload.tasks))
        .catch(() => undefined)
    }, 10_000)
    return () => clearInterval(timer)
  }, [])

  const selected = selectedId && selectedId !== 'new' ? tasks.find((item) => item.id === selectedId) ?? null : null

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">自动化任务</div>
          <div className="page-sub">绑定好友 · 手动 / 定时 · 系统拉信 · 立即运行 · 历史</div>
        </div>
        <div className="grow" />
        <button className="btn" type="button" onClick={() => setSelectedId('new')}>
          ＋ 新建任务
        </button>
      </header>
      <div className="page-bd">
        {error ? <p className="form-error">{error}</p> : null}
        <div className="page-layout">
          <section className="card">
            <div className="card-hd">
              <h2>全部任务</h2>
              <div className="grow" />
              <span className="tag">{tasks.length}</span>
            </div>
            <div className="card-bd" style={{ padding: 8 }}>
              {tasks.length === 0 ? <p className="empty">还没有任务。</p> : null}
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={task.id === selectedId ? 'list-item is-active' : 'list-item'}
                  onClick={() => setSelectedId(task.id)}
                >
                  <span className={dotClass(task.lastStatus)} />
                  <span className="list-item-meta">
                    <span className="list-item-title">
                      {task.name}
                      {isSystemMailTask(task) ? <span className="tag" style={{ marginLeft: 6 }}>系统拉信</span> : null}
                    </span>
                    <span className="task-meta-line">
                      <span className="tag">好友 · {friends.find((item) => item.id === task.friendId)?.name ?? '未知'}</span>
                      <span className="tag">{task.schedule === 'cron' ? `定时 · ${task.cron}` : '手动'}</span>
                      <span className={statusTag(task.lastStatus)}>{statusText(task.lastStatus)}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            {selectedId ? (
              <TaskForm
                key={selected?.id ?? 'new'}
                task={selected}
                friends={friends}
                conversations={conversations}
                onOpenMail={onOpenMail}
                onSaved={async (id) => {
                  const list = await reload()
                  setSelectedId(id ?? list[0]?.id ?? null)
                }}
              />
            ) : (
              <p className="empty">选一个任务，或新建。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function TaskForm({
  task,
  friends,
  conversations,
  onSaved,
  onOpenMail,
}: {
  task: AutomationTask | null
  friends: Friend[]
  conversations: ConversationCard[]
  onSaved: (id?: string) => Promise<void>
  onOpenMail?: () => void
}) {
  const [name, setName] = useState(task?.name ?? '')
  const [friendId, setFriendId] = useState(task?.friendId ?? friends[0]?.id ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? (isSystemMailTask(task) ? MAIL_SYSTEM_DESCRIPTION : ''))
  const [target, setTarget] = useState(task?.targetConversationId ?? '')
  const [schedule, setSchedule] = useState<'manual' | 'cron'>(task?.schedule ?? 'manual')
  const [cron, setCron] = useState(task?.cron ?? '0 9 * * 1-5')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const running = task?.lastStatus === 'running'
  const mailSystem = isSystemMailTask(task)
  let nextRun: Date | null = null
  let cronError = ''
  if (schedule === 'cron' && cron.trim()) {
    try {
      nextRun = nextCronTime(cron.trim())
    } catch (cause) {
      cronError = cause instanceof Error ? cause.message : 'Cron 格式不对'
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      const path = task ? `/api/tasks/${encodeURIComponent(task.id)}` : '/api/tasks'
      const payload = await requestJson<{ ok: true; task: AutomationTask }>(path, {
        method: task ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          friendId,
          prompt: mailSystem ? MAIL_SYSTEM_DESCRIPTION : prompt,
          ...(mailSystem || task?.kind ? { kind: mailSystem ? 'system_mail_poll' : task?.kind } : {}),
          schedule,
          cron: schedule === 'cron' ? cron : '',
          targetConversationId: target,
        }),
      })
      await onSaved(payload.task.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有保存')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: 'contents' }}>
      <div className="card-hd">
        <h2>{task ? `编辑 · ${name || task.name}` : '新建任务'}{mailSystem ? ' · 系统拉信' : ''}</h2>
        <div className="grow" />
        {task ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void requestJson(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }).then(() => onSaved())
            }}
          >
            删除
          </button>
        ) : null}
      </div>
      <div className="card-bd" style={{ background: 'var(--panel-bg)' }}>
        <div className="inset-stack">
          <div>
            <div className="inset-section-title">基本信息</div>
            <div className="inset-group">
              <label className="inset-row">
                <span className="inset-label">名称<span className="req">*</span></span>
                <span className="inset-value"><input value={name} readOnly={mailSystem} className={mailSystem ? 'is-readonly' : undefined} onChange={(event) => setName(event.target.value)} /></span>
              </label>
              <label className="inset-row">
                <span className="inset-label">绑定好友<span className="req">*</span></span>
                <span className="inset-value">
                  <select value={friendId} onChange={(event) => setFriendId(event.target.value)}>
                    {friends.map((friend) => (
                      <option key={friend.id} value={friend.id}>{friend.name}</option>
                    ))}
                  </select>
                </span>
              </label>
              {mailSystem ? (
                <div className="inset-row">
                  <span className="inset-label">类型</span>
                  <span className="inset-value" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="tag">系统拉信</span>
                    <span className="help" style={{ margin: 0 }}>kind · system_mail_poll</span>
                  </span>
                </div>
              ) : null}
              <label className="inset-row">
                <span className="inset-label">目标会话</span>
                <span className="inset-value">
                  <select value={target} onChange={(event) => setTarget(event.target.value)}>
                    <option value="">{mailSystem ? '（不指定 · 写入绑定好友默认/新建私聊）' : '不指定，写入绑定好友私聊'}</option>
                    {conversations.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </select>
                </span>
              </label>
              {!mailSystem ? (
                <label className="inset-row">
                  <span className="inset-label">提示词</span>
                  <span className="inset-value">
                    <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                  </span>
                </label>
              ) : null}
            </div>
            <p className="inset-hint">{mailSystem ? '绑定好友必填（默认群主）。目标会话可选；空则写入该好友默认/新建私聊。' : '目标会话可选；留空则结果只记在运行历史里。'}</p>
          </div>
          {mailSystem ? (
            <div>
              <div className="inset-section-title">说明（非好友提示词）</div>
              <div className="mail-note" role="note">
                <p style={{ margin: '0 0 8px' }}>
                  <strong>应用侧</strong>用 IMAP 自己拉信 → 白名单过滤 → 把正文作为工作指令写入
                  <strong>绑定好友会话</strong>并触发对话 → SMTP 回结果摘要。<strong>模型不连邮箱</strong>。
                </p>
                <p className="help" style={{ margin: '0 0 8px' }}>
                  这不是普通「好友提示词」任务，不会把拉信交给模型找邮箱工具。
                </p>
                <p className="help" style={{ margin: 0 }}>
                  真正规则在{' '}
                  {onOpenMail ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenMail}>
                      设置 → 邮箱 / 工作指令
                    </button>
                  ) : (
                    '设置 → 邮箱 / 工作指令'
                  )}
                  （IMAP / SMTP / 白名单）。
                </p>
              </div>
            </div>
          ) : null}
          <div>
            <div className="inset-section-title">调度</div>
            <div className="inset-group">
              <div className="inset-row">
                <span className="inset-label">运行方式</span>
                <span className="inset-value">
                  <span className="seg">
                    <button type="button" className={schedule === 'manual' ? 'seg-btn is-active' : 'seg-btn'} onClick={() => setSchedule('manual')}>手动</button>
                    <button type="button" className={schedule === 'cron' ? 'seg-btn is-active' : 'seg-btn'} onClick={() => setSchedule('cron')}>定时</button>
                  </span>
                </span>
              </div>
              {schedule === 'cron' ? (
                <label className="inset-row">
                  <span className="inset-label">Cron</span>
                  <span className="inset-value">
                    <input value={cron} spellCheck={false} placeholder="分 时 日 月 周" onChange={(event) => setCron(event.target.value)} />
                  </span>
                </label>
              ) : null}
            </div>
            {schedule === 'cron' ? (
              <p className="inset-hint" style={{ marginTop: 8 }}>
                {cronError
                  ? `Cron 格式：${cronError}`
                  : nextRun
                    ? `下次运行：${formatNextRun(nextRun)}（按本机时区；服务需保持运行）`
                    : '按本机时区执行；服务需保持运行。'}
              </p>
            ) : null}
          </div>
          {task && task.history.length > 0 ? (
            <div>
              <div className="inset-section-title">运行历史</div>
              <div className="history-list">
                {task.history.map((item) => (
                  <div key={item.id} className="history-item">
                    <span className={item.status === 'success' ? 'status-dot on' : item.status === 'running' ? 'status-dot warn' : 'status-dot err'} />
                    <span className="when">{new Date(item.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    <span className="result">{item.result || item.error || item.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </div>
      <div className="card-ft">
        <button className="btn" type="submit" disabled={pending}>{pending ? '保存中' : '保存'}</button>
        {task ? (
          running ? (
            <button
              type="button"
              className="btn btn-stop"
              onClick={() => {
                void requestJson(`/api/tasks/${encodeURIComponent(task.id)}/stop`, { method: 'POST' }).then(() => onSaved(task.id))
              }}
            >
              终止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void requestJson(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST' })
                  .then(() => onSaved(task.id))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '没有跑起来'))
              }}
            >
              立即运行
            </button>
          )
        ) : null}
      </div>
    </form>
  )
}

function dotClass(status: AutomationTask['lastStatus']): string {
  if (status === 'success') return 'status-dot on'
  if (status === 'running') return 'status-dot warn'
  if (status === 'error') return 'status-dot err'
  return 'status-dot'
}

function statusTag(status: AutomationTask['lastStatus']): string {
  if (status === 'success') return 'tag tag-ok'
  if (status === 'error') return 'tag tag-err'
  return 'tag'
}

function statusText(status: AutomationTask['lastStatus']): string {
  if (status === 'success') return '上次成功'
  if (status === 'error') return '上次失败'
  if (status === 'running') return '运行中'
  if (status === 'cancelled') return '已终止'
  return '尚未运行'
}

function formatNextRun(date: Date): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}
