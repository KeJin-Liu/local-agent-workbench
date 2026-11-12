/**
 * QQ 式会话列：搜索、头像、最后一句、时间。没有真实未读时不显示红点。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { buildContactDirectory, contactRowIsOpen, directoryEmptyCopy, type ContactFilter } from '../app/directory.ts'
import { previewMemberWorkspace } from '../domain/group-workspace.ts'
import { OWNER_FRIEND_ID } from '../storage/schema.ts'
import type { ConversationCard, Friend, FriendAvatar, GroupMemberModel, LongTermMemory, McpServerView, McpTransport, PublicProvider } from '../domain/types.ts'
import { requestJson, uploadAvatar } from './api.ts'
import { Avatar } from './avatar.tsx'
import { formatListTime, formatShanghai } from './format.ts'

export function ConversationList({
  conversations,
  friends,
  selectedId,
  onSelect,
  onOpenFriend,
  onCreateFriend,
  onCreateGroup,
}: {
  conversations: ConversationCard[]
  friends: Friend[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 打开已有单聊，没有则按好友名字新建再打开。 */
  onOpenFriend: (friend: Friend) => Promise<void>
  onCreateFriend: () => void
  onCreateGroup: () => void
}) {
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState(false)
  const [filter, setFilter] = useState<ContactFilter>('all')
  const [openingId, setOpeningId] = useState<string | null>(null)
  const needle = query.trim().toLowerCase()
  const current = conversations.find((item) => item.id === selectedId)
  const visible = buildContactDirectory(conversations, friends, filter).filter((row) => {
    if (!needle) return true
    return [row.title, row.preview, row.friend?.name ?? ''].join('\n').toLowerCase().includes(needle)
  })

  async function openFriend(friend: Friend) {
    if (openingId) return
    setOpeningId(friend.id)
    try {
      await onOpenFriend(friend)
    } finally {
      setOpeningId(null)
    }
  }

  return (
    <aside className="sessions">
      <div className="sessions-top">
        <input
          className="search-input"
          value={query}
          placeholder="搜索好友或群"
          aria-label="搜索通讯录"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn-icon"
            title="新建"
            aria-haspopup="true"
            onClick={() => setMenu((value) => !value)}
          >
            ＋
          </button>
          {menu ? (
            <div className="menu-pop is-open" role="menu">
              <button
                type="button"
                onClick={() => {
                  setMenu(false)
                  onCreateFriend()
                }}
              >
                新建好友
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu(false)
                  onCreateGroup()
                }}
              >
                发起群聊
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="session-tabs" role="tablist" aria-label="通讯录分类">
        {(
          [
            ['all', '全部'],
            ['friend', '好友'],
            ['group', '群组'],
            ['archive', '归档'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            className={filter === value ? 'session-tab is-active' : 'session-tab'}
            aria-selected={filter === value}
            data-filter={value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="session-list">
        {visible.length === 0 ? (
          <p className="empty">
            {directoryEmptyCopy(
              filter,
              query,
              friends.length,
              conversations.filter((item) => item.kind === 'group').length,
            )}
          </p>
        ) : (
          visible.map((row) => {
            const selected = contactRowIsOpen(row, current)
            const pinned = row.kind === 'friend' && row.friend?.id === OWNER_FRIEND_ID
            return (
              <button
                key={row.key}
                type="button"
                data-type={row.kind === 'group' ? 'group' : 'friend'}
                data-id={row.kind === 'friend' ? row.friend?.id : row.conversation?.id}
                data-pinned={pinned ? '1' : undefined}
                className={[selected ? 'session is-active' : 'session', pinned ? 'is-pinned' : ''].filter(Boolean).join(' ')}
                aria-current={selected ? 'true' : undefined}
                disabled={Boolean(openingId)}
                onClick={() => {
                  if (row.kind === 'friend' && row.friend) void openFriend(row.friend)
                  else if (row.conversation) onSelect(row.conversation.id)
                }}
              >
                <Avatar avatar={row.kind === 'friend' ? row.friend?.avatar : row.conversation?.avatar} name={row.kind === 'group' ? '群' : row.title} />
                <span className="session-meta">
                  <span className="session-row1">
                    <span className="session-name">
                      {row.title}
                      {pinned ? <span className="session-pin">置顶</span> : null}
                    </span>
                    <span className="session-time">{formatListTime(row.updatedAt)}</span>
                  </span>
                  <span className="session-row2">
                    <span className="session-preview">{row.preview}</span>
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}

export function NewChatDialog({
  friends,
  providers = [],
  seed,
  projectOwnerId,
  conversationId,
  onPersisted,
  onClose,
  onCreate,
}: {
  friends: Friend[]
  providers?: PublicProvider[]
  seed?: {
    title: string
    friendIds: string[]
    model?: string
    avatar?: FriendAvatar
    workspaceRoot?: string
    memberWorkspaces?: Record<string, string>
    memberPrompts?: Record<string, string>
    memberModels?: Record<string, GroupMemberModel>
    archived?: boolean
  }
  conversationId?: string
  projectOwnerId?: string
  /** 已有群把提示词立刻写入后刷新列表，不关闭群设置。 */
  onPersisted?: () => Promise<void>
  onClose: () => void
  onCreate: (input: {
    title: string
    friendIds: string[]
    kind: 'group'
    model?: string
    avatar: FriendAvatar | null
    workspaceRoot?: string
    memberWorkspaces?: Record<string, string>
    memberPrompts?: Record<string, string>
    memberModels?: Record<string, GroupMemberModel>
  }) => Promise<void>
}) {
  const [title, setTitle] = useState(seed?.title ?? '')
  const [picked, setPicked] = useState<string[]>(seed?.friendIds ?? friends.slice(0, 2).map((friend) => friend.id))
  const [avatar, setAvatar] = useState<FriendAvatar | null>(seed?.avatar ?? null)
  const [workspaceRoot, setWorkspaceRoot] = useState(seed?.workspaceRoot ?? '')
  const [memberWorkspaces, setMemberWorkspaces] = useState<Record<string, string>>(seed?.memberWorkspaces ?? {})
  const [memberPrompts, setMemberPrompts] = useState<Record<string, string>>(seed?.memberPrompts ?? {})
  const [memberModels, setMemberModels] = useState<Record<string, GroupMemberModel>>(seed?.memberModels ?? {})
  const [promptEditor, setPromptEditor] = useState<{ id: string; draft: string; modelChoice: string } | null>(null)
  const [promptSaving, setPromptSaving] = useState(false)
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null)
  const [pickingFolder, setPickingFolder] = useState<string | null>(null)
  const [memberPickerOpen, setMemberPickerOpen] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [memories, setMemories] = useState<LongTermMemory[]>([])
  const groupMcp = useGroupMcp(conversationId, projectOwnerId)
  const archived = Boolean(seed?.archived)

  useEffect(() => {
    if (!projectOwnerId) {
      setMemories([])
      return
    }
    let stop = false
    void requestJson<{ ok: true; memories: LongTermMemory[] }>(
      `/api/long-term-memories?scope=project&ownerId=${encodeURIComponent(projectOwnerId)}`,
    )
      .then((payload) => {
        if (!stop) setMemories(payload.memories)
      })
      .catch(() => {
        if (!stop) setMemories([])
      })
    return () => {
      stop = true
    }
  }, [projectOwnerId])

  function groupPayload(prompts: Record<string, string>, models: Record<string, GroupMemberModel>) {
    const overrides = Object.fromEntries(
      picked.flatMap((id) => {
        const value = memberWorkspaces[id]?.trim()
        return value ? [[id, value]] : []
      }),
    )
    const cleaned = Object.fromEntries(
      picked.flatMap((id) => {
        const value = prompts[id]?.trim()
        return value ? [[id, value]] : []
      }),
    )
    const cleanedModels = Object.fromEntries(
      picked.flatMap((id) => {
        const value = models[id]
        const providerId = value?.providerId?.trim()
        const modelId = value?.model?.trim()
        return providerId && modelId ? [[id, { providerId, model: modelId }]] : []
      }),
    )
    return {
      title: title.trim(),
      friendIds: picked,
      kind: 'group' as const,
      avatar,
      workspaceRoot: workspaceRoot.trim(),
      memberWorkspaces: overrides,
      memberPrompts: cleaned,
      memberModels: cleanedModels,
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (uploading) {
      setError('头像还在上传，等完成后再保存。')
      return
    }
    setPending(true)
    setError('')
    try {
      await onCreate(groupPayload(memberPrompts, memberModels))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有建成')
      setPending(false)
    }
  }

  /** 已有群立刻写入本群提示词和模型。新建群还没有 id，先留在表单里。 */
  async function persistMember(nextPrompts: Record<string, string>, nextModels: Record<string, GroupMemberModel>) {
    if (!conversationId) {
      setMemberPrompts(nextPrompts)
      setMemberModels(nextModels)
      return
    }
    setPromptSaving(true)
    setError('')
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PUT',
        body: JSON.stringify(groupPayload(nextPrompts, nextModels)),
      })
      setMemberPrompts(nextPrompts)
      setMemberModels(nextModels)
      await onPersisted?.()
    } finally {
      setPromptSaving(false)
    }
  }

  async function toggleArchive() {
    if (!conversationId || archiving || pending) return
    setArchiving(true)
    setError('')
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: !archived }),
      })
      await onPersisted?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档没有写入')
      setArchiving(false)
    }
  }

  async function pickFolder(target: string) {
    if (pickingFolder) return
    setError('')
    setPickingFolder(target)
    try {
      const payload = await requestJson<{ ok: true; cancelled?: boolean; path: string | null }>('/api/workspace/pick-folder', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (payload.cancelled || !payload.path) return
      if (target === 'root') setWorkspaceRoot(payload.path)
      else setMemberWorkspaces((current) => ({ ...current, [target]: payload.path as string }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择文件夹失败')
    } finally {
      setPickingFolder(null)
    }
  }

  const workspacePreview = {
    kind: 'group' as const,
    title: title.trim() || '未命名群',
    ...(workspaceRoot.trim() ? { workspaceRoot: workspaceRoot.trim() } : {}),
    memberWorkspaces,
  }

  const memberQueryText = memberQuery.trim().toLowerCase()
  const pickerFriends = friends.filter((friend) => {
    if (!memberQueryText) return true
    return friend.name.toLowerCase().includes(memberQueryText) || friend.description.toLowerCase().includes(memberQueryText)
  })

  return (
    <>
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-scroll group-settings-modal">
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-hd">
            <h2>{seed ? '群设置' : '发起群聊'}</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="modal-bd" style={{ background: 'var(--panel-bg)' }}>
            <div className="group-settings-grid">
              <div className="group-settings-col">
              <div>
                <div className="inset-section-title">群信息</div>
                <div className="inset-group">
                  <label className="inset-row">
                    <span className="inset-label">
                      群名称<span className="req">*</span>
                    </span>
                    <span className="inset-value">
                      <input value={title} placeholder="例如：产品联调群" onChange={(event) => setTitle(event.target.value)} />
                    </span>
                  </label>
                </div>
              </div>
              <div>
                <div className="inset-section-title">群头像</div>
                <div className="inset-group" style={{ padding: '12px 14px' }}>
                  <div className="group-avatar-row">
                    <Avatar avatar={avatar ?? undefined} name="群" size="lg" />
                    <div className="group-avatar-meta">
                      <div className="group-avatar-name">{avatar ? '已设置群头像' : '默认群头像'}</div>
                      <p className="help">
                        支持 PNG / JPEG / WEBP / GIF，最大 2MB。群列表和聊天顶栏会同步显示。
                      </p>
                    </div>
                    <div className="group-avatar-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={uploading || pending}
                        onClick={() => avatarInputRef.current?.click()}
                      >
                        {uploading ? '上传中…' : avatar ? '更换' : '上传'}
                      </button>
                      {avatar ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={uploading || pending}
                          onClick={() => setAvatar(null)}
                        >
                          恢复默认
                        </button>
                      ) : null}
                    </div>
                    <input
                      ref={avatarInputRef}
                      className="sr-only"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      disabled={uploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) return
                        setUploading(true)
                        setError('')
                        void uploadAvatar(file)
                          .then((next) => setAvatar(next))
                          .catch((cause) => setError(cause instanceof Error ? cause.message : '头像上传失败'))
                          .finally(() => setUploading(false))
                      }}
                    />
                  </div>
                </div>
              </div>
              <div>
                <div className="inset-section-title member-section-hd">
                  <span>成员（至少 2 个好友）</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setMemberQuery('')
                      setMemberPickerOpen(true)
                    }}
                  >
                    添加
                  </button>
                </div>
                <div className="inset-group" style={{ padding: '12px 14px' }}>
                  {picked.length === 0 ? <p className="help">还没有成员。点「添加」从好友里选。</p> : null}
                  <div className="member-pick">
                    {friends.filter((friend) => picked.includes(friend.id)).map((friend) => (
                      <span key={friend.id} className={memberPrompts[friend.id]?.trim() || memberModels[friend.id] ? 'member-chip is-on has-prompt' : 'member-chip is-on'}>
                        <button
                          type="button"
                          className="member-chip-main"
                          onClick={() => {
                            const override = memberModels[friend.id]
                            setPromptEditor({
                              id: friend.id,
                              draft: memberPrompts[friend.id] ?? friend.systemPrompt,
                              modelChoice: override ? encodeMemberModel(override.providerId, override.model) : '',
                            })
                          }}
                        >
                          <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                          {friend.name}
                        </button>
                        <button
                          type="button"
                          className="member-chip-x"
                          aria-label={`移除 ${friend.name}`}
                          onClick={() => setRemoveMemberId(friend.id)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
                <p className="inset-hint">已选 {picked.length} 人。点名字设置本群的提示词和模型，点 × 确认后再移出。</p>
              </div>
              </div>
              <div className="group-settings-col">
              <GroupMcpSection mcp={groupMcp} />
              {projectOwnerId ? (
                <div>
                  <div className="inset-section-title">项目长期记忆</div>
                  <div className="inset-group" style={{ padding: '0 12px' }}>
                    {memories.length === 0 ? <p className="help">还没有项目记忆。</p> : null}
                    <div className="skill-attached-list ltm-preview-list">
                      {memories.map((item) => (
                        <div key={item.id} className="skill-attached-item">
                          <div className="sk-icon" style={{ background: 'rgba(0,122,255,0.12)', color: 'var(--accent)' }}>
                            记
                          </div>
                          <div className="sk-meta">
                            <div className="sk-name">{item.fact}</div>
                            <div className="sk-desc">
                              {item.source === 'auto' ? '自动提炼' : '手动添加'} · {formatShanghai(item.updatedAt)}
                              {item.injectEnabled ? '' : ' · 已停注入'}
                            </div>
                          </div>
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            onClick={() => {
                              void requestJson(`/api/long-term-memories/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).then(() =>
                                setMemories((current) => current.filter((row) => row.id !== item.id)),
                              )
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="inset-hint" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span>跨会话项目事实；聊天顶栏也可管理。共 {memories.length} 条。</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => {
                        const fact = window.prompt('添加一条项目/群长期记忆：')
                        if (!fact?.trim() || !projectOwnerId) return
                        void requestJson<{ ok: true; memory: LongTermMemory }>('/api/long-term-memories', {
                          method: 'POST',
                          body: JSON.stringify({ scope: 'project', ownerId: projectOwnerId, fact: fact.trim(), source: 'manual' }),
                        }).then((payload) => setMemories((current) => [payload.memory, ...current]))
                      }}
                    >
                      添加
                    </button>
                  </p>
                </div>
              ) : null}
              <div>
                <div className="inset-section-title">群工作空间</div>
                <div className="inset-group">
                  <div className="inset-row">
                    <span className="inset-label">根目录</span>
                    <span className="inset-value">
                      <code className="ws-path" title={workspaceRoot || '未设置'}>
                        {workspaceRoot || '未设置'}
                      </code>
                    </span>
                  </div>
                </div>
                <p className="inset-hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={Boolean(pickingFolder) || pending}
                    onClick={() => void pickFolder('root')}
                  >
                    {pickingFolder === 'root' ? '选择中…' : workspaceRoot ? '更换目录' : '选择文件夹'}
                  </button>
                  {workspaceRoot ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setWorkspaceRoot('')}>
                      清除
                    </button>
                  ) : null}
                  <span>设置后，成员默认在「根目录/群名称/好友名」里读写删，不用再确认写入。单聊仍用好友自己的目录。</span>
                </p>
                <div className="inset-group" style={{ padding: '8px 14px' }}>
                  {friends.filter((friend) => picked.includes(friend.id)).map((friend) => {
                    const manual = Boolean(memberWorkspaces[friend.id]?.trim())
                    const preview = previewMemberWorkspace(workspacePreview, friend)
                    return (
                      <div key={friend.id} className="inset-row" style={{ alignItems: 'flex-start' }}>
                        <span className="inset-label">{friend.name}</span>
                        <span className="inset-value" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                          <code className="ws-path" title={preview.path || '未设置'}>
                            {preview.path || (friend.workspacePath ? `沿用 ${friend.workspacePath}` : '未设置')}
                          </code>
                          <span style={{ display: 'flex', gap: 8 }}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={Boolean(pickingFolder) || pending}
                              onClick={() => void pickFolder(friend.id)}
                            >
                              {pickingFolder === friend.id ? '选择中…' : manual ? '更换手动目录' : '手动指定'}
                            </button>
                            {manual ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={pending}
                                onClick={() =>
                                  setMemberWorkspaces((current) => {
                                    const next = { ...current }
                                    delete next[friend.id]
                                    return next
                                  })
                                }
                              >
                                恢复自动
                              </button>
                            ) : null}
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
              </div>
              {error ? <p className="form-error group-settings-error">{error}</p> : null}
            </div>
          </div>
          <div className="modal-ft">
            {conversationId ? (
              <button
                type="button"
                className="btn btn-secondary modal-ft-lead"
                disabled={pending || uploading || archiving}
                onClick={() => void toggleArchive()}
              >
                {archiving ? '处理中…' : archived ? '取消归档' : '归档'}
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={archiving}>
              取消
            </button>
            <button type="submit" className="btn" disabled={pending || uploading || archiving || title.trim().length === 0}>
              {pending ? '保存中' : uploading ? '头像上传中…' : seed ? '保存' : '创建群聊'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {memberPickerOpen ? (
      <div className="modal-backdrop member-picker-backdrop" role="dialog" aria-modal="true" aria-label="添加成员">
        <div className="modal modal-scroll member-picker">
          <div className="modal-hd">
            <h2>添加成员</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => setMemberPickerOpen(false)}>
              ✕
            </button>
          </div>
          <div className="modal-bd member-picker-bd">
            <input
              className="member-picker-search"
              value={memberQuery}
              placeholder="搜索好友"
              aria-label="搜索好友"
              onChange={(event) => setMemberQuery(event.target.value)}
            />
            <div className="member-picker-list" role="listbox" aria-label="好友">
              {pickerFriends.length === 0 ? <p className="help">没有匹配的好友。</p> : null}
              {pickerFriends.map((friend) => {
                const selected = picked.includes(friend.id)
                return (
                  <button
                    key={friend.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? 'member-picker-row is-on' : 'member-picker-row'}
                    onClick={() =>
                      setPicked((current) =>
                        current.includes(friend.id) ? current.filter((id) => id !== friend.id) : [...current, friend.id],
                      )
                    }
                  >
                    <Avatar avatar={friend.avatar} name={friend.name} size="sm" />
                    <span className="member-picker-meta">
                      <span className="member-picker-name">{friend.name}</span>
                      {friend.description ? <span className="member-picker-desc">{friend.description}</span> : null}
                    </span>
                    <span className={selected ? 'tag tag-ok' : 'tag'}>{selected ? '已添加' : '添加'}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="modal-ft">
            <span className="member-picker-count">已选 {picked.length} 人</span>
            <button type="button" className="btn" onClick={() => setMemberPickerOpen(false)}>
              完成
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {promptEditor ? (
      <MemberPromptDialog
        friend={friends.find((item) => item.id === promptEditor.id)}
        providers={providers}
        draft={promptEditor.draft}
        modelChoice={promptEditor.modelChoice}
        saved={Boolean(memberPrompts[promptEditor.id]?.trim() || memberModels[promptEditor.id])}
        saving={promptSaving}
        persisted={Boolean(conversationId)}
        onDraft={(draft) => setPromptEditor({ ...promptEditor, draft })}
        onModelChoice={(modelChoice) => setPromptEditor({ ...promptEditor, modelChoice })}
        onClose={() => {
          if (!promptSaving) setPromptEditor(null)
        }}
        onSave={() => {
          const text = promptEditor.draft.trim()
          const nextPrompts = { ...memberPrompts }
          if (text) nextPrompts[promptEditor.id] = text
          else delete nextPrompts[promptEditor.id]
          const nextModels = { ...memberModels }
          const chosen = decodeMemberModel(promptEditor.modelChoice)
          if (chosen) nextModels[promptEditor.id] = chosen
          else delete nextModels[promptEditor.id]
          void persistMember(nextPrompts, nextModels)
            .then(() => setPromptEditor(null))
            .catch((cause) => setError(cause instanceof Error ? cause.message : '本群设置没有写入'))
        }}
        onClear={() => {
          const nextPrompts = { ...memberPrompts }
          const nextModels = { ...memberModels }
          delete nextPrompts[promptEditor.id]
          delete nextModels[promptEditor.id]
          void persistMember(nextPrompts, nextModels)
            .then(() => setPromptEditor(null))
            .catch((cause) => setError(cause instanceof Error ? cause.message : '本群设置没有清除'))
        }}
      />
    ) : null}
    {removeMemberId ? (
      <div className="modal-backdrop member-picker-backdrop" role="dialog" aria-modal="true" aria-label="移出成员">
        <div className="modal member-confirm">
          <div className="modal-hd">
            <h2>移出成员</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => setRemoveMemberId(null)}>
              ✕
            </button>
          </div>
          <div className="modal-bd">
            <p>
              把「{friends.find((item) => item.id === removeMemberId)?.name ?? '这位好友'}」移出这个群？为本群保存的提示词和模型会一起去掉，好友资料不受影响。
            </p>
          </div>
          <div className="modal-ft">
            <button type="button" className="btn btn-secondary" onClick={() => setRemoveMemberId(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const id = removeMemberId
                setPicked((current) => current.filter((item) => item !== id))
                setMemberPrompts((current) => {
                  const next = { ...current }
                  delete next[id]
                  return next
                })
                setMemberWorkspaces((current) => {
                  const next = { ...current }
                  delete next[id]
                  return next
                })
                setMemberModels((current) => {
                  const next = { ...current }
                  delete next[id]
                  return next
                })
                setRemoveMemberId(null)
              }}
            >
              移出
            </button>
          </div>
        </div>
      </div>
    ) : null}
    <GroupMcpDialogs mcp={groupMcp} />
    </>
  )
}

function useGroupMcp(conversationId?: string, lineageId?: string) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [mode, setMode] = useState<'create' | 'attach' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [argsText, setArgsText] = useState('')
  const lineage = lineageId || conversationId || ''

  async function reload() {
    const payload = await requestJson<{ ok: true; servers: McpServerView[] }>('/api/mcp')
    setServers(payload.servers)
  }

  useEffect(() => {
    if (!conversationId) {
      setServers([])
      return
    }
    let stop = false
    void requestJson<{ ok: true; servers: McpServerView[] }>('/api/mcp')
      .then((payload) => {
        if (!stop) setServers(payload.servers)
      })
      .catch(() => {
        if (!stop) setServers([])
      })
    return () => {
      stop = true
    }
  }, [conversationId])

  const bound = servers.filter((server) => server.scope === 'groups' && lineage && server.groupIds?.includes(lineage))
  const attachable = servers.filter((server) => server.scope === 'groups' && lineage && !server.groupIds?.includes(lineage))
  const globalCount = servers.filter((server) => (server.scope ?? 'global') === 'global').length
  const friendScoped = servers.some((server) => server.scope === 'friends')

  async function writeBindings(serverIds: string[]) {
    if (!conversationId) return
    setPending(true)
    setError('')
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/mcp`, {
        method: 'PUT',
        body: JSON.stringify({ serverIds }),
      })
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '群 MCP 没有写入')
      throw cause
    } finally {
      setPending(false)
    }
  }

  async function detach(serverId: string) {
    await writeBindings(bound.filter((server) => server.id !== serverId).map((server) => server.id))
  }

  async function attach(serverId: string) {
    await writeBindings([...bound.map((server) => server.id), serverId])
    setMode(null)
  }

  async function createServer() {
    if (!conversationId || !lineage) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('MCP 名称不能为空。')
      return
    }
    setPending(true)
    setError('')
    try {
      await requestJson('/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          transport,
          enabled: true,
          scope: 'groups',
          groupIds: [lineage],
          command: transport === 'stdio' ? command.trim() : undefined,
          url: transport === 'stdio' ? undefined : url.trim(),
          args: transport === 'stdio' && argsText.trim() ? argsText.trim().split(/\s+/) : [],
          env: [],
          headers: [],
        }),
      })
      setName('')
      setCommand('')
      setUrl('')
      setArgsText('')
      setTransport('stdio')
      setMode(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '群 MCP 没有建成')
    } finally {
      setPending(false)
    }
  }

  return {
    conversationId,
    bound,
    attachable,
    globalCount,
    friendScoped,
    mode,
    setMode,
    pending,
    error,
    name,
    setName,
    transport,
    setTransport,
    command,
    setCommand,
    url,
    setUrl,
    argsText,
    setArgsText,
    detach,
    attach,
    createServer,
  }
}

function GroupMcpSection({ mcp }: { mcp: ReturnType<typeof useGroupMcp> }) {
  return (
    <div>
      <div className="inset-section-title member-section-hd">
        <span>群 MCP</span>
        {mcp.conversationId ? (
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={mcp.pending} onClick={() => mcp.setMode('attach')}>
              挂已有
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={mcp.pending} onClick={() => mcp.setMode('create')}>
              新建
            </button>
          </span>
        ) : null}
      </div>
      {!mcp.conversationId ? (
        <p className="inset-hint">创建群聊后，可以在这里挂只属于这个群的 MCP。</p>
      ) : (
        <>
          <div className="inset-group" style={{ padding: '0 12px' }}>
            {mcp.bound.length === 0 ? <p className="help">还没有本群专属的 MCP。</p> : null}
            <div className="skill-attached-list">
              {mcp.bound.map((server) => (
                <div key={server.id} className="skill-attached-item">
                  <div className="sk-icon" style={{ background: 'rgba(0,122,255,0.12)', color: 'var(--accent)' }}>
                    接
                  </div>
                  <div className="sk-meta">
                    <div className="sk-name">{server.name}</div>
                    <div className="sk-desc">
                      {server.transport}
                      {server.enabled ? ' · 已启用' : ' · 未启用'}
                      {' · 仅本群'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={mcp.pending}
                    onClick={() => void mcp.detach(server.id).catch(() => undefined)}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          </div>
          <p className="inset-hint">
            只在这个群的每一段对话里可用，谁发言都能调用。
            {mcp.globalCount > 0 ? `另外 ${mcp.globalCount} 个全局服务处处可用，不用再挂一次。` : '全局服务仍然处处可用，不用再挂一次。'}
            {mcp.friendScoped ? '指定好友的服务只在该好友发言时进入本群。' : ''}
          </p>
          {mcp.error && mcp.mode === null ? <p className="form-error">{mcp.error}</p> : null}
        </>
      )}
    </div>
  )
}

function GroupMcpDialogs({ mcp }: { mcp: ReturnType<typeof useGroupMcp> }) {
  if (mcp.mode === 'attach') {
    return (
      <div className="modal-backdrop member-picker-backdrop" role="dialog" aria-modal="true" aria-label="挂到本群">
        <div className="modal modal-scroll member-picker">
          <div className="modal-hd">
            <h2>挂到本群</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => mcp.setMode(null)}>
              ✕
            </button>
          </div>
          <div className="modal-bd member-picker-bd">
            {mcp.attachable.length === 0 ? <p className="help">没有其他群级服务。可以新建一条，只挂在这个群。</p> : null}
            <div className="member-picker-list">
              {mcp.attachable.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  className="member-picker-row"
                  disabled={mcp.pending}
                  onClick={() => void mcp.attach(server.id).catch(() => undefined)}
                >
                  <span className="member-picker-meta">
                    <span className="member-picker-name">{server.name}</span>
                    <span className="member-picker-desc">{server.transport} · 指定群</span>
                  </span>
                  <span className="tag">挂上</span>
                </button>
              ))}
            </div>
            {mcp.error ? <p className="form-error">{mcp.error}</p> : null}
          </div>
          <div className="modal-ft">
            <button type="button" className="btn" onClick={() => mcp.setMode(null)}>
              完成
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (mcp.mode !== 'create') return null
  return (
    <div
      className="modal-backdrop member-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="新建群 MCP"
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault()
      }}
    >
      <div className="modal modal-scroll">
        <div className="modal-hd">
          <h2>新建群 MCP</h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" disabled={mcp.pending} onClick={() => mcp.setMode(null)}>
            ✕
          </button>
        </div>
        <div className="modal-bd">
          <p className="inset-hint" style={{ marginTop: 0 }}>
            保存后只在这个群里可用，并立刻启用。命令和密钥细节以后仍可在 MCP 页改。
          </p>
          <label className="inset-row">
            <span className="inset-label">名称</span>
            <span className="inset-value">
              <input value={mcp.name} placeholder="例如：群内文件系统" onChange={(event) => mcp.setName(event.target.value)} />
            </span>
          </label>
          <label className="inset-row">
            <span className="inset-label">传输</span>
            <span className="inset-value">
              <select value={mcp.transport} onChange={(event) => mcp.setTransport(event.target.value as McpTransport)}>
                <option value="stdio">stdio</option>
                <option value="sse">sse</option>
                <option value="http">http</option>
              </select>
            </span>
          </label>
          {mcp.transport === 'stdio' ? (
            <>
              <label className="inset-row">
                <span className="inset-label">命令</span>
                <span className="inset-value">
                  <input value={mcp.command} placeholder="node" onChange={(event) => mcp.setCommand(event.target.value)} />
                </span>
              </label>
              <label className="inset-row">
                <span className="inset-label">参数</span>
                <span className="inset-value">
                  <input value={mcp.argsText} placeholder="用空格分开" onChange={(event) => mcp.setArgsText(event.target.value)} />
                </span>
              </label>
            </>
          ) : (
            <label className="inset-row">
              <span className="inset-label">URL</span>
              <span className="inset-value">
                <input value={mcp.url} placeholder="http://127.0.0.1:3000/mcp" onChange={(event) => mcp.setUrl(event.target.value)} />
              </span>
            </label>
          )}
          {mcp.error ? <p className="form-error">{mcp.error}</p> : null}
        </div>
        <div className="modal-ft">
          <button type="button" className="btn btn-secondary" disabled={mcp.pending} onClick={() => mcp.setMode(null)}>
            取消
          </button>
          <button type="button" className="btn" disabled={mcp.pending || mcp.name.trim().length === 0} onClick={() => void mcp.createServer()}>
            {mcp.pending ? '保存中' : '保存到本群'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MemberPromptDialog({
  friend,
  providers,
  draft,
  modelChoice,
  saved,
  saving,
  persisted,
  onDraft,
  onModelChoice,
  onClose,
  onSave,
  onClear,
}: {
  friend: Friend | undefined
  providers: PublicProvider[]
  draft: string
  modelChoice: string
  saved: boolean
  saving: boolean
  /** 已有群会立刻写入；新建群要等创建。 */
  persisted: boolean
  onDraft: (draft: string) => void
  onModelChoice: (choice: string) => void
  onClose: () => void
  onSave: () => void
  onClear: () => void
}) {
  const currentLabel = friend ? friendModelLabel(friend, providers) : '未设置'
  const choices = memberModelChoices(providers)
  return (
    <div className="modal-backdrop member-picker-backdrop" role="dialog" aria-modal="true" aria-label="本群成员设置">
      <div className="modal modal-scroll member-picker">
        <div className="modal-hd">
          <h2>{friend ? `${friend.name} · 本群` : '本群成员'}</h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-bd member-picker-bd">
          <p className="inset-hint" style={{ marginTop: 0 }}>
            只对当前群生效，不会改好友资料。没选模型时，用好友自己的当前模型。
          </p>
          <label className="inset-row" style={{ marginBottom: 12 }}>
            <span className="inset-label">本群模型</span>
            <span className="inset-value">
              <select aria-label="本群模型" value={modelChoice} onChange={(event) => onModelChoice(event.target.value)}>
                <option value="">{`使用好友当前模型 · ${currentLabel}`}</option>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <span className="chevron">›</span>
            </span>
          </label>
          <p className="inset-hint">
            {saved
              ? persisted
                ? '已写入当前群。单聊仍用好友自己的提示词和模型。'
                : '创建群聊时才会写入。'
              : '提示词不保存则本群不注入。模型不选则用好友当前模型。'}
          </p>
          <textarea
            className="member-prompt-input"
            value={draft}
            aria-label="本群提示词"
            placeholder="本群不注入提示词"
            onChange={(event) => onDraft(event.target.value)}
          />
        </div>
        <div className="modal-ft">
          {saved ? (
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClear}>
              清除
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onSave}>
            {saving ? '保存中…' : '保存到本群'}
          </button>
        </div>
      </div>
    </div>
  )
}

const MEMBER_MODEL_SEP = '\u001f'

function encodeMemberModel(providerId: string, model: string): string {
  return `${providerId}${MEMBER_MODEL_SEP}${model}`
}

function decodeMemberModel(value: string): GroupMemberModel | null {
  const index = value.indexOf(MEMBER_MODEL_SEP)
  if (index <= 0) return null
  const providerId = value.slice(0, index).trim()
  const model = value.slice(index + 1).trim()
  if (!providerId || !model) return null
  return { providerId, model }
}

function friendModelLabel(friend: Friend, providers: PublicProvider[]): string {
  const provider = providers.find((item) => item.id === friend.providerId)
  const model = friend.defaultModelId || provider?.defaultModel
  return [provider?.name, model].filter(Boolean).join(' · ') || '未设置'
}

function memberModelChoices(providers: PublicProvider[]): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    const models = provider.probedModels?.length
      ? provider.probedModels
      : provider.defaultModel
        ? [provider.defaultModel]
        : []
    for (const id of models) {
      choices.push({ value: encodeMemberModel(provider.id, id), label: `${provider.name.replace(/ 本地$/, '')} · ${id}` })
    }
  }
  return choices
}
