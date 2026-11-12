/**
 * p1.4 ConfirmCard 配置类 kind 正文，对齐 agent-chat-ui/propose.html。
 */
import type { Friend, Proposal } from '../domain/types.ts'
import { Avatar } from './avatar.tsx'

import { buildAppSettingsDiff } from './propose-config-diff.ts'

function draftString(draft: Record<string, unknown>, key: string): string {
  const value = draft[key]
  return typeof value === 'string' ? value.trim() : ''
}

function draftStringList(draft: Record<string, unknown>, key: string): string[] {
  const value = draft[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function bindTargetLabel(draft: Record<string, unknown>): string {
  const target = draftString(draft, 'bindTarget') || 'provider'
  if (target === 'mail_imap') return '邮箱 · IMAP 密码'
  if (target === 'mail_smtp') return '邮箱 · SMTP 密码'
  const providerId = draftString(draft, 'providerId') || draftString(draft, 'id')
  return providerId ? `提供方 · ${providerId} · API Key` : '提供方 · API Key'
}

export function ConfigProposalBody({
  proposal,
  friends,
}: {
  proposal: Proposal
  friends: Friend[]
}) {
  const draft = proposal.draft
  if (proposal.kind === 'provider') return <ProviderBody draft={draft} name={proposal.name} />
  if (proposal.kind === 'app_settings') return <AppSettingsBody draft={draft} summary={proposal.summary} />
  if (proposal.kind === 'friend_patch') return <FriendPatchBody draft={draft} friends={friends} />
  if (proposal.kind === 'group') return <GroupBody draft={draft} friends={friends} name={proposal.name} />
  if (proposal.kind === 'vault_binding') return <VaultBindingBody draft={draft} name={proposal.name} />
  return (
    <div className="propose-config-fields">
      <p className="propose-summary">{proposal.summary}</p>
    </div>
  )
}

function ProviderBody({ draft, name }: { draft: Record<string, unknown>; name: string }) {
  const masked = draftString(draft, 'apiKeyMasked')
  const vaultLabel = draftString(draft, 'name') || name
  const enabled = draft.enabled === undefined ? true : Boolean(draft.enabled)
  return (
    <div className="propose-config-fields" data-config-kind="provider">
      <div className="inset-section-title">名称</div>
      <p className="propose-summary">{draftString(draft, 'name') || name}</p>
      <div className="inset-section-title">Base URL</div>
      <p className="propose-summary">{draftString(draft, 'baseUrl') || '—'}</p>
      <div className="inset-section-title">默认模型</div>
      <p className="propose-summary">{draftString(draft, 'defaultModel') || '—'}</p>
      <div className="inset-section-title">API Key（脱敏）</div>
      <div className="propose-key-row" style={{ marginBottom: 8 }}>
        <span className="masked key-mask">{masked || '（未提供新 Key）'}</span>
        <span className="chip chip-muted vault-bind-chip" title="确认后写入保险库再引用">
          🔐 保险库 · {vaultLabel}
        </span>
      </div>
      <div className="propose-enable-row">
        <span className={enabled ? 'toggle is-on' : 'toggle'} aria-hidden="true" />
        <span>{enabled ? '启用此提供方' : '保存为停用'}</span>
      </div>
      <p className="field-help">Key 落库走保险库引用；确认卡与历史永不回显完整明文。</p>
    </div>
  )
}

function AppSettingsBody({ draft, summary }: { draft: Record<string, unknown>; summary: string }) {
  const items = buildAppSettingsDiff(draft)
  return (
    <div className="propose-config-fields" data-config-kind="app_settings">
      <div className="inset-section-title">变更摘要（diff）</div>
      <ul className="propose-diff" aria-label="应用设置 diff">
        {items.map((item) =>
          item.unchanged ? (
            <li key={item.key} className="propose-diff-item is-unchanged">
              <span className="diff-key">{item.key}</span>
              <span className="diff-note">未改</span>
            </li>
          ) : (
            <li key={item.key} className="propose-diff-item">
              <span className="diff-key">{item.key}</span>
              <span className="diff-arrow" aria-hidden="true">
                →
              </span>
              <span className="diff-new">{item.next}</span>
            </li>
          ),
        )}
      </ul>
      {summary ? <p className="propose-summary">{summary}</p> : null}
      <p className="field-help">仅列出本卡 patch 字段；确认后写 app_settings，设置页可见一致结果。</p>
    </div>
  )
}

function FriendPatchBody({ draft, friends }: { draft: Record<string, unknown>; friends: Friend[] }) {
  const friendId = draftString(draft, 'friendId')
  const friend = friends.find((item) => item.id === friendId)
  const name = friend?.name || draftString(draft, 'name') || '未知好友'
  return (
    <div className="propose-config-fields" data-config-kind="friend_patch">
      <div className="friend-patch-target">
        <Avatar avatar={friend?.avatar} name={name} size="sm" />
        <div>
          <div className="friend-patch-name">{name}</div>
          <div className="friend-patch-id">friendId · {friendId || '—'}</div>
        </div>
      </div>
      {draft.systemPrompt !== undefined ? (
        <>
          <div className="inset-section-title">系统提示词</div>
          <p className="propose-summary">{String(draft.systemPrompt)}</p>
        </>
      ) : null}
      {draft.workspacePath !== undefined ? (
        <>
          <div className="inset-section-title">工作目录</div>
          <p className="propose-summary">{draftString(draft, 'workspacePath') || '（清除）'}</p>
        </>
      ) : null}
      {draft.defaultModelId !== undefined || draft.model !== undefined ? (
        <>
          <div className="inset-section-title">默认模型</div>
          <p className="propose-summary">{draftString(draft, 'defaultModelId') || draftString(draft, 'model') || '（清除）'}</p>
        </>
      ) : null}
      <p className="field-help">确认后更新该好友；通讯录与好友设置页可见一致结果。</p>
    </div>
  )
}

function GroupBody({
  draft,
  friends,
  name,
}: {
  draft: Record<string, unknown>
  friends: Friend[]
  name: string
}) {
  const title = draftString(draft, 'title') || draftString(draft, 'name') || name
  const memberIds = draftStringList(draft, 'friendIds')
  const action = draftString(draft, 'action') || 'create'
  return (
    <div className="propose-config-fields" data-config-kind="group">
      <div className="inset-section-title">群名</div>
      <p className="propose-summary">{title}</p>
      <div className="inset-section-title">成员（{action === 'add_members' ? '加成员' : '新建/更新'}）</div>
      <div className="propose-member-list" aria-label="成员列表">
        {memberIds.length === 0 ? <div className="propose-member">（无成员）</div> : null}
        {memberIds.map((id) => {
          const friend = friends.find((item) => item.id === id)
          return (
            <div key={id} className="propose-member is-checked">
              <Avatar avatar={friend?.avatar} name={friend?.name || id} size="sm" />
              {friend?.name || id}
            </div>
          )
        })}
      </div>
      <p className="field-help">确认后建群或改成员；通讯录「＋ → 发起群聊」仍保留。</p>
    </div>
  )
}

function VaultBindingBody({ draft, name }: { draft: Record<string, unknown>; name: string }) {
  const masked = draftString(draft, 'apiKeyMasked') || draftString(draft, 'passwordMasked') || '••••••••••••'
  return (
    <div className="propose-config-fields" data-config-kind="vault_binding">
      <div className="inset-section-title">保险库条目</div>
      <p className="propose-summary">{draftString(draft, 'name') || name}</p>
      <div className="inset-section-title">密钥（不回显全文）</div>
      <div className="propose-key-row" style={{ marginBottom: 10 }}>
        <span className="masked key-mask">{masked}</span>
        <span className="chip chip-muted">全文不回显 · 确认写入保险库</span>
      </div>
      <div className="inset-section-title">绑定到</div>
      <p className="propose-summary">{bindTargetLabel(draft)}</p>
      <p className="field-help">创建条目并绑到引用位；气泡与历史禁止完整密钥。</p>
    </div>
  )
}
