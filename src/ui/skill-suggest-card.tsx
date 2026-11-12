/**
 * 系统「建议保存为技能」确认卡。忽略不落库；确认后挂到好友。
 */

import { useState } from 'react'
import type { Friend, SkillSuggestion } from '../domain/types.ts'
import { requestJson } from './api.ts'
import { Avatar } from './avatar.tsx'

export function SkillSuggestCard({
  suggestion,
  friends,
  onDone,
  onAccepted,
}: {
  suggestion: SkillSuggestion
  friends: Friend[]
  onDone: () => void
  onAccepted?: (friendName: string, skillName: string) => void
}) {
  const [name, setName] = useState(suggestion.name)
  const [scope, setScope] = useState<'global' | 'friends'>('friends')
  const [picked, setPicked] = useState<string[]>([suggestion.friendId])
  const [muteSimilar, setMuteSimilar] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [doneLabel, setDoneLabel] = useState('')

  async function accept() {
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/skill-suggestions/${encodeURIComponent(suggestion.id)}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          scope,
          friendIds: scope === 'friends' ? picked : [],
          muteSimilar,
        }),
      })
      const friendName =
        scope === 'friends'
          ? friends
              .filter((friend) => picked.includes(friend.id))
              .map((friend) => friend.name)
              .join('、') || '好友'
          : '全局'
      setDoneLabel(friendName)
      setDone(true)
      onAccepted?.(friendName, name.trim() || suggestion.name)
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有写入')
    } finally {
      setPending(false)
    }
  }

  async function dismiss() {
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/skill-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ muteSimilar }),
      })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有忽略')
    } finally {
      setPending(false)
    }
  }

  if (done) {
    return (
      <div className="confirm-card is-done" role="status">
        <div className="confirm-card-hd">
          <div className="cc-icon">✓</div>
          <div>
            <div className="cc-title">已挂到好友 · {doneLabel}</div>
            <div className="cc-sub">{name || suggestion.name} · 可在好友编辑页「已挂技能」查看</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="confirm-card" role="group" aria-label="建议保存为技能">
      <div className="confirm-card-hd">
        <div className="cc-icon">✨</div>
        <div>
          <div className="cc-title">建议保存为技能</div>
          <div className="cc-sub">
            系统检测到重复模式 · 近 7 天出现 <strong>{suggestion.occurrenceCount}</strong> 次 · 未确认不落库
          </div>
        </div>
      </div>
      <div className="confirm-card-bd">
        <div className="inset-section-title" style={{ marginTop: 4 }}>
          建议名称
        </div>
        <div className="inset-group" style={{ marginBottom: 12 }}>
          <div className="inset-row">
            <input type="text" value={name} aria-label="技能名称" onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <div className="inset-section-title">步骤预览</div>
        <ol className="steps-preview" style={{ marginBottom: 12 }}>
          {suggestion.steps.map((step, index) => (
            <li key={`${index}-${step}`}>
              <span className="step-n">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="confirm-q">挂到哪里？</div>
        <div className="scope-options">
          <button type="button" className={scope === 'global' ? 'scope-opt is-selected' : 'scope-opt'} onClick={() => setScope('global')}>
            <span className="radio" aria-hidden="true" />
            <span>
              <div className="opt-title">全局（所有好友可用）</div>
              <div className="opt-desc">技能对全部好友可见</div>
            </span>
          </button>
          <button type="button" className={scope === 'friends' ? 'scope-opt is-selected' : 'scope-opt'} onClick={() => setScope('friends')}>
            <span className="radio" aria-hidden="true" />
            <span>
              <div className="opt-title">指定好友</div>
              <div className="opt-desc">默认当前好友</div>
            </span>
          </button>
        </div>
        {scope === 'friends' ? (
          <div className="friend-multi is-open" aria-label="选择好友">
            {friends.map((friend) => (
              <button
                key={friend.id}
                type="button"
                className={picked.includes(friend.id) ? 'friend-multi-item is-checked' : 'friend-multi-item'}
                onClick={() =>
                  setPicked((current) =>
                    current.includes(friend.id) ? current.filter((id) => id !== friend.id) : [...current, friend.id],
                  )
                }
              >
                <span className="check" />
                <Avatar avatar={friend.avatar} name={friend.name} size="sm" /> {friend.name}
              </button>
            ))}
          </div>
        ) : null}
        <label className="suggest-mute" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          <input type="checkbox" checked={muteSimilar} onChange={(event) => setMuteSimilar(event.target.checked)} /> 以后不再建议类似模式
        </label>
        <p className="confirm-note">系统建议 · 忽略不落库；确认保存后出现在好友「已挂技能」。</p>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      <div className="confirm-card-ft">
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void dismiss()}>
          忽略
        </button>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void accept()}>
          {pending ? '写入中' : '确认保存'}
        </button>
      </div>
    </div>
  )
}
