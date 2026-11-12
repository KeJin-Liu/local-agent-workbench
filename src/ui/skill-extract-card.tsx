/**
 * p1.3：会话抽技能确认卡。确认才写入好友已挂技能；取消不落库。
 * 作用域固定当前好友（不做全局 / 跨好友）。
 */

import { useState } from 'react'
import type { Friend, Skill, SkillExtractDraft } from '../domain/types.ts'
import { requestJson } from './api.ts'
import { Avatar } from './avatar.tsx'

export function SkillExtractCard({
  draft,
  friend,
  onDone,
  onConfirmed,
}: {
  draft: SkillExtractDraft
  friend?: Friend
  onDone: () => void
  onConfirmed?: (skill: Skill, friendName: string) => void
}) {
  const [name, setName] = useState(draft.name)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function confirm() {
    setPending(true)
    setError('')
    try {
      const payload = await requestJson<{ ok: true; skill: Skill; draft: SkillExtractDraft }>(
        `/api/skill-extracts/${encodeURIComponent(draft.id)}/confirm`,
        { method: 'POST', body: JSON.stringify({ name: name.trim() || draft.name }) },
      )
      setDone(true)
      onConfirmed?.(payload.skill, friend?.name ?? '好友')
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有写入')
    } finally {
      setPending(false)
    }
  }

  async function cancel() {
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/skill-extracts/${encodeURIComponent(draft.id)}/cancel`, {
        method: 'POST',
        body: '{}',
      })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有取消')
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
            <div className="cc-title">已挂到好友 · {friend?.name ?? '好友'}</div>
            <div className="cc-sub">{name || draft.name} · 可在好友编辑页「已挂技能」查看</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="confirm-card" role="group" aria-label="保存为好友技能">
      <div className="confirm-card-hd">
        <div className="cc-icon">✨</div>
        <div>
          <div className="cc-kind">会话抽技能</div>
          <div className="cc-title">保存为好友技能</div>
          <div className="cc-sub">从所选会话提炼 · 确认前不落库</div>
        </div>
      </div>
      <div className="confirm-card-bd">
        <div className="inset-section-title" style={{ marginTop: 4 }}>
          技能名称
        </div>
        <div className="inset-group" style={{ marginBottom: 12 }}>
          <div className="inset-row">
            <input type="text" value={name} aria-label="技能名称" onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <div className="inset-section-title">步骤预览</div>
        <ol className="steps-preview" style={{ marginBottom: 12 }}>
          {(draft.steps.length > 0 ? draft.steps : ['（草案未解析出步骤，确认后仍可保存）']).map((step, index) => (
            <li key={`${index}-${step}`}>
              <span className="step-n">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="inset-section-title">作用域</div>
        <div className="scope-fixed" style={{ marginBottom: 8 }}>
          {friend ? <Avatar avatar={friend.avatar} name={friend.name} size="sm" /> : <span className="sk-icon">友</span>}
          <span>
            固定 · <strong>{friend?.name ?? '当前好友'}</strong>（本包不做全局 / 跨好友）
          </span>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      <div className="confirm-card-ft">
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void cancel()}>
          取消
        </button>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void confirm()}>
          {pending ? '保存中…' : '确认保存'}
        </button>
      </div>
    </div>
  )
}
