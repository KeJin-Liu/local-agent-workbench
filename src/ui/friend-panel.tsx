/**
 * 好友二级页：左列表，右编辑。头像用内置色块，也可以上传。
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { CodePermission, Friend, FriendAvatar, LongTermMemory, PublicProvider, Skill } from '../domain/types.ts'
import { OWNER_FRIEND_ID } from '../storage/schema.ts'
import { DEFAULT_FRIEND_AVATAR } from '../domain/types.ts'
import { requestJson, uploadAvatar, type DefaultAvatar } from './api.ts'
import { Avatar } from './avatar.tsx'
import { formatShanghai } from './format.ts'

type FormState = {
  id?: string
  name: string
  description: string
  systemPrompt: string
  avatar: FriendAvatar
  providerId: string
  defaultModelId: string
  workspacePath: string
  codePermission: CodePermission
  visionEnabled: boolean
  visionProviderId: string
  visionModelId: string
}

const PERM_DESC: Record<CodePermission, string> = {
  'read-only': '只读：仅 list / read / grep。写文件与 shell 禁用。',
  'workspace-write': '工作区写入（默认）：可提议写文件与 shell；每次仍需确认门闩；确认前磁盘不变。',
  'danger-full-access': '危险全开：写文件、删除和 shell 在已绑定目录内直接执行，不再逐次确认。',
}

function codeGateTag(permission: CodePermission): { text: string; className: string } {
  if (permission === 'read-only') return { text: '禁用', className: 'tag tag-warn' }
  if (permission === 'danger-full-access') return { text: '直接执行', className: 'tag tag-warn' }
  return { text: '需确认', className: 'tag tag-ok' }
}

const TONE: Record<string, string> = {
  seal: 'av-seal',
  crane: 'av-crane',
  pine: 'av-pine',
  lantern: 'av-lantern',
  moon: 'av-moon',
  brush: 'av-brush',
}

/** 列表里只露最后一段目录名，完整路径放在 title 上。 */
function workspaceBaseName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

export function FriendPanel({
  friends,
  defaults,
  providers,
  focusId,
  createToken = 0,
  onSaved,
  onOpenChat,
  onCancel,
}: {
  friends: Friend[]
  defaults: DefaultAvatar[]
  providers: PublicProvider[]
  /** 从聊天齿轮进来时定位到这个好友。 */
  focusId?: string | null
  /** 递增时打开空白的新建好友表单。 */
  createToken?: number
  onSaved: () => Promise<void>
  onOpenChat?: (friend: { id: string; name: string }) => void
  /** 取消编辑：丢掉本次改动并回到聊天窗口。 */
  onCancel?: () => void
}) {
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [pastePath, setPastePath] = useState('')
  const [uploading, setUploading] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [memories, setMemories] = useState<LongTermMemory[]>([])


  async function pickWorkspaceFolder() {
    if (!form || pickingFolder) return
    setError('')
    setPickingFolder(true)
    try {
      const payload = await requestJson<{ ok: true; cancelled?: boolean; path: string | null }>('/api/workspace/pick-folder', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (payload.cancelled || !payload.path) {
        setError('')
        return
      }
      setForm({ ...form, workspacePath: payload.path, codePermission: form.codePermission || 'workspace-write' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '选择文件夹失败')
    } finally {
      setPickingFolder(false)
    }
  }

  useEffect(() => {
    if (!form?.id) {
      setSkills([])
      setMemories([])
      return
    }
    let stop = false
    void requestJson<{ ok: true; skills: Skill[] }>(`/api/skills?friendId=${encodeURIComponent(form.id)}`)
      .then((payload) => {
        if (!stop) setSkills(payload.skills)
      })
      .catch(() => {
        if (!stop) setSkills([])
      })
    void requestJson<{ ok: true; memories: LongTermMemory[] }>(
      `/api/long-term-memories?scope=friend&ownerId=${encodeURIComponent(form.id)}`,
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
  }, [form?.id])

  useEffect(() => {
    if (!focusId) return
    const friend = friends.find((item) => item.id === focusId)
    if (friend) beginEdit(friend)
    // 只在齿轮带入的 id 变化时定位，避免保存后冲掉正在改的字段。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  useEffect(() => {
    if (createToken === 0) return
    beginCreate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createToken])

  useEffect(() => {
    if (form || friends.length === 0 || focusId || createToken) return
    const first = friends[0]
    if (first) beginEdit(first)
    // 只在还没选中时补上第一条，避免保存后把正在编辑的内容盖掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends])

  function beginCreate() {
    const first = defaults[0]
    setError('')
    const fallback = providers.find((item) => item.enabled)?.id ?? providers[0]?.id ?? ''
    setPastePath('')
    setForm({
      name: '',
      description: '',
      systemPrompt: '',
      avatar: first ? { kind: 'default', id: first.id, path: first.path } : { ...DEFAULT_FRIEND_AVATAR },
      providerId: fallback,
      defaultModelId: '',
      workspacePath: '',
      codePermission: 'workspace-write',
      visionEnabled: false,
      visionProviderId: fallback,
      visionModelId: '',
    })
  }

  function beginEdit(friend: Friend) {
    setError('')
    setPastePath('')
    setForm({
      id: friend.id,
      name: friend.name,
      description: friend.description,
      systemPrompt: friend.systemPrompt,
      avatar: friend.avatar,
      providerId: friend.providerId,
      defaultModelId: friend.defaultModelId ?? '',
      workspacePath: friend.workspacePath ?? '',
      codePermission: friend.codePermission ?? 'workspace-write',
      visionEnabled: Boolean(friend.vision?.enabled),
      visionProviderId: friend.vision?.providerId ?? friend.providerId,
      visionModelId: friend.vision?.modelId ?? '',
    })
  }

  async function onUpload(file: File | undefined) {
    if (!file || !form) return
    setUploading(true)
    setError('')
    try {
      const avatar = await uploadAvatar(file)
      setForm({ ...form, avatar })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function persist(): Promise<boolean> {
    if (!form) return false
    setPending(true)
    setError('')
    try {
      const path = form.id ? `/api/friends/${encodeURIComponent(form.id)}` : '/api/friends'
      const saved = await requestJson<{ ok: true; friend: Friend }>(path, {
        method: form.id ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          systemPrompt: form.systemPrompt,
          providerId: form.providerId,
          defaultModelId: form.defaultModelId,
          avatar: form.avatar,
          workspacePath: form.workspacePath.trim(),
          codePermission: form.workspacePath.trim() ? form.codePermission : '',
          vision: {
            enabled: form.visionEnabled,
            providerId: form.visionProviderId || form.providerId,
            modelId: form.visionModelId.trim(),
          },
        }),
      })
      if (Boolean(saved.friend?.vision?.enabled) !== form.visionEnabled) {
        throw new Error(
          '视觉插件没有写入本地库：当前本地工作台进程还没加载这条改动。重启本地工作台（pnpm dev / pnpm start）后再试，data/ 里的数据不会动。',
        )
      }
      await onSaved()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '好友没有保存')
      return false
    } finally {
      setPending(false)
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    await persist()
  }

  /** 取消 = 放弃本次编辑；有上层路由时直接回聊天窗口，不把半截表单留在页上。 */
  function cancelEdit() {
    setError('')
    setPastePath('')
    setForm(friends[0] ? formFrom(friends[0]) : null)
    onCancel?.()
  }

  const sortedFriends = [...friends].sort((a, b) => {
    if (a.id === OWNER_FRIEND_ID) return -1
    if (b.id === OWNER_FRIEND_ID) return 1
    return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh')
  })
  const providerName = (id: string) => providers.find((item) => item.id === id)?.name ?? id
  // 已上传头像在编辑页也要可见；没有 path 的旧数据仍按未上传处理。
  const uploadedAvatar = form?.avatar.kind === 'upload' && form.avatar.path ? form.avatar : null

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">好友管理</div>
          <div className="page-sub">从聊天顶栏设置进入 · 系统提示词醒目可编辑 · 已挂技能可预览 · p1.3</div>
        </div>
        <div className="grow" />
        <button className="btn" type="button" onClick={beginCreate}>
          ＋ 新建好友
        </button>
      </header>
      <div className="page-bd">
        <div className="page-layout friend-layout">
          <section className="card" aria-label="好友列表">
            <div className="card-hd">
              <h2>全部好友</h2>
              <div className="grow" />
              <span className="tag">{friends.length}</span>
            </div>
            <div className="card-bd friend-list" style={{ padding: 8 }}>
              {friends.length === 0 ? <p className="empty">还没有好友。重新打开时会种入「群主」。</p> : null}
              {sortedFriends.map((friend) => {
                const model = friend.defaultModelId?.trim() ?? ''
                const workspace = friend.workspacePath?.trim() ?? ''
                const provider = providerName(friend.providerId)
                return (
                  <button
                    key={friend.id}
                    type="button"
                    className={form?.id === friend.id ? 'list-item friend-row is-active' : 'list-item friend-row'}
                    onClick={() => beginEdit(friend)}
                  >
                    <Avatar avatar={friend.avatar} name={friend.name} />
                    <span className="friend-row-body">
                      <span className="friend-row-head">
                        <span className="friend-row-name">{friend.name}</span>
                        {friend.isOwnerTemplate ? <span className="tag tag-ok">模板</span> : null}
                      </span>
                      <span className="friend-row-line">
                        <span className="friend-row-k">模型</span>
                        <span className="friend-row-v" title={model ? `${provider} · ${model}` : provider}>
                          {model || '未设置'}
                        </span>
                      </span>
                      <span className="friend-row-line">
                        <span className="friend-row-k">目录</span>
                        <span className={workspace ? 'friend-row-status is-set' : 'friend-row-status is-unset'}>
                          {workspace ? '已设置' : '未设置'}
                        </span>
                        {workspace ? (
                          <span className="friend-row-path" title={workspace}>
                            {workspaceBaseName(workspace)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
          <section className="card friend-edit-card" aria-label="编辑好友">
            <div className="card-hd">
              <h2>{form?.id ? `编辑 · ${form.name || '好友'}` : '新建好友'}</h2>
              <div className="grow" />
              {form ? (
                <span className={form.workspacePath.trim() ? 'tag tag-ok' : 'tag'}>
                  {form.workspacePath.trim() ? '已设工作目录' : '未设置（可选）'}
                </span>
              ) : null}
            </div>
            {form ? (
              <form className="form" onSubmit={(event) => void onSubmit(event)} style={{ display: 'contents' }}>
                <div className="card-bd">
                  <div className="form">
                    <div className="field">
                      <label>头像</label>
                      <div className="avatar-grid" role="listbox" aria-label="选择头像">
                        {defaults.map((item) => {
                          const pressed = form.avatar.kind === 'default' && form.avatar.id === item.id
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={`avatar-opt ${TONE[item.id] ?? 'av-prod'}${pressed ? ' is-selected' : ''}`}
                              title={item.label}
                              aria-pressed={pressed}
                              onClick={() => setForm({ ...form, avatar: { kind: 'default', id: item.id, path: item.path } })}
                            >
                              {item.label}
                            </button>
                          )
                        })}
                        <label
                          className={`avatar-opt avatar-opt-upload${uploadedAvatar ? ' has-image is-selected' : ''}`}
                          title={uploadedAvatar ? '更换头像' : '上传头像'}
                        >
                          {uploadedAvatar ? (
                            <>
                              <img className="avatar-opt-img" src={uploadedAvatar.path} alt="当前上传的头像" />
                              <span className="avatar-opt-change">{uploading ? '上传中…' : '更换'}</span>
                            </>
                          ) : (
                            <>
                              <span style={{ fontSize: 18 }}>{uploading ? '…' : '＋'}</span>
                              <span>{uploading ? '上传中' : '上传'}</span>
                            </>
                          )}
                          <input
                            className="sr-only"
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            disabled={uploading}
                            onChange={(event) => {
                              const file = event.target.files?.[0]
                              // 清空 value，同一张图重选也能再次触发上传。
                              event.target.value = ''
                              if (file) void onUpload(file)
                            }}
                          />
                        </label>
                      </div>
                      <div className="help">内置：印 / 鹤 / 松 / 灯 / 月 / 笔；也可上传 PNG / JPEG / WEBP / GIF</div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>名称<span className="req">*</span></label>
                        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                      </div>
                      <div className="field">
                        <label>提供方</label>
                        <select value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })}>
                          {providers.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                              {provider.enabled ? '' : '（停用）'}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>默认模型</label>
                        <input
                          value={form.defaultModelId}
                          spellCheck={false}
                          placeholder="发送时可再换"
                          onChange={(event) => setForm({ ...form, defaultModelId: event.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label>摘要</label>
                        <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
                      </div>
                    </div>
                    <div className="field vision-plugin" data-on={form.visionEnabled ? '1' : '0'}>
                      <label>视觉插件</label>
                      <div className="inset-group" style={{ padding: '10px 12px' }}>
                        <div className="inset-row" style={{ alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="vision-plugin-title">识别会话图片</div>
                            <div className="help">
                              会话里有图片的回合会交给视觉模型读图；需要模型支持图片输入（如 qwen2.5vl / gpt-4o）。
                            </div>
                          </div>
                          <button
                            type="button"
                            className={form.visionEnabled ? 'toggle is-on' : 'toggle'}
                            aria-pressed={form.visionEnabled}
                            title={form.visionEnabled ? '已开启' : '已关闭'}
                            onClick={() => setForm({ ...form, visionEnabled: !form.visionEnabled })}
                          />
                        </div>
                        {form.visionEnabled ? (
                          <>
                            <label className="inset-row">
                              <span className="inset-label">提供方</span>
                              <span className="inset-value">
                                <select
                                  value={form.visionProviderId || form.providerId}
                                  onChange={(event) => setForm({ ...form, visionProviderId: event.target.value })}
                                >
                                  {providers.map((provider) => (
                                    <option key={provider.id} value={provider.id}>
                                      {provider.name}
                                      {provider.enabled ? '' : '（停用）'}
                                    </option>
                                  ))}
                                </select>
                              </span>
                            </label>
                            <label className="inset-row">
                              <span className="inset-label">视觉模型</span>
                              <span className="inset-value">
                                <input
                                  value={form.visionModelId}
                                  spellCheck={false}
                                  placeholder="留空沿用好友默认模型"
                                  onChange={(event) => setForm({ ...form, visionModelId: event.target.value })}
                                />
                              </span>
                            </label>
                          </>
                        ) : null}
                      </div>
                      <div className="help">
                        开启后只在有图片的回合切到视觉模型，文字回合仍用好友默认模型；图片在本地内联给模型。
                      </div>
                    </div>
                    <div className="field friend-sysprompt-field">
                      <label>
                        系统提示词 <span className="tag tag-ok" style={{ marginLeft: 4, fontWeight: 500 }}>可见可编辑</span>
                      </label>
                      <textarea
                        className="friend-sysprompt-ta"
                        rows={8}
                        placeholder="未设置"
                        aria-label="好友系统提示词"
                        value={form.systemPrompt}
                        onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
                      />
                      <div className="help">
                        好友自身人设 / Friend.systemPrompt。空则占位「未设置」。抽技能全局提示词见设置页「抽技能 · 系统提示词」。
                      </div>
                    </div>

                    <div className="field ws-bind" data-bound={form.workspacePath.trim() ? '1' : '0'} data-permission={form.codePermission}>
                      <label>
                        工作目录 <span className="ws-optional-badge">可选</span>
                      </label>
                      <p className="ws-help">
                        本机编码沙箱（Workspace）。<strong>可不选</strong>：聊天 / 模型 / 记忆照常；仅 list·read·grep·写文件·shell 不启用。选中后工具才挂上。工作区写入时，写与 shell 仍走确认；选「危险全开」则直接执行。
                        <strong>主路径是「选择文件夹」</strong>（桌面端系统目录对话框），不是手填绝对路径。
                      </p>
                      {!form.workspacePath.trim() ? (
                        <div className="ws-empty">
                          <div className="ws-empty-icon" aria-hidden="true">📁</div>
                          <div className="ws-empty-title">未设置工作目录</div>
                          <div className="ws-empty-desc">
                            工作目录为<strong>可选项</strong>。当前未绑定：
                            <ul className="ws-empty-list">
                              <li>本机读写 / shell <strong>未启用</strong>（不会访问磁盘）</li>
                              <li>聊天、模型、记忆、技能、MCP <strong>仍可用</strong></li>
                              <li>需要结对改代码时，再选本机文件夹即可</li>
                            </ul>
                          </div>
                          <button type="button" className="btn" disabled={pickingFolder} onClick={() => void pickWorkspaceFolder()}>
                            {pickingFolder ? '选择中…' : '选择文件夹'}
                          </button>
                          <p className="field-help" style={{ marginTop: 10 }}>
                            人话提示对齐：「请先绑定工作目录」——仅在用户要调编码工具时出现。
                          </p>
                          <details className="ws-advanced">
                            <summary>高级 · 粘贴路径</summary>
                            <div className="ws-paste-row">
                              <input
                                type="text"
                                className="field"
                                value={pastePath}
                                placeholder="/绝对/路径/到/项目"
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(event) => setPastePath(event.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  const next = pastePath.trim()
                                  if (!next) return
                                  setForm({ ...form, workspacePath: next, codePermission: form.codePermission || 'workspace-write' })
                                  setPastePath('')
                                }}
                              >
                                绑定
                              </button>
                            </div>
                            <p className="field-help">可选兜底；生产仍建议优先系统选文件夹。</p>
                          </details>
                        </div>
                      ) : (
                        <div className="ws-bound">
                          <div className="inset-group ws-path-group">
                            <div className="inset-row ws-path-row">
                              <div className="ws-path-label">
                                当前路径 <span className="ws-path-ro">不可手改</span>
                              </div>
                              <code className="ws-path" aria-readonly="true">{form.workspacePath}</code>
                            </div>
                          </div>
                          <div className="ws-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={pickingFolder}
                              onClick={() => void pickWorkspaceFolder()}
                            >
                              {pickingFolder ? '选择中…' : '更换文件夹'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm ws-clear-btn"
                              title="清除后回到未设置空态，编码工具全禁"
                              onClick={() => {
                                setForm({ ...form, workspacePath: '', codePermission: 'workspace-write' })
                                setPastePath('')
                              }}
                            >
                              清除
                            </button>
                          </div>
                          <p className="field-help">
                            「选择 / 更换文件夹」走系统目录选择器。「清除」= 解绑，编码能力关闭，聊天不受影响。
                          </p>
                          <details className="ws-advanced">
                            <summary>高级 · 粘贴路径</summary>
                            <div className="ws-paste-row">
                              <input
                                type="text"
                                className="field"
                                value={pastePath}
                                placeholder="/绝对/路径/到/项目"
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(event) => setPastePath(event.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  const next = pastePath.trim()
                                  if (!next) return
                                  setForm({ ...form, workspacePath: next })
                                  setPastePath('')
                                }}
                              >
                                应用
                              </button>
                            </div>
                            <p className="field-help">非主路径；仅在无法唤起系统选目录时使用。</p>
                          </details>
                          <div className="inset-section-title" style={{ marginTop: 14 }}>代码权限</div>
                          <div className="seg ws-perm-seg" role="tablist" aria-label="代码权限三档">
                            {([
                              ['read-only', '只读'],
                              ['workspace-write', '工作区写入'],
                              ['danger-full-access', '危险全开'],
                            ] as const).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                className={form.codePermission === value ? 'seg-btn is-active' : 'seg-btn'}
                                role="tab"
                                aria-selected={form.codePermission === value}
                                onClick={() => setForm({ ...form, codePermission: value })}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <div className="ws-perm-desc">
                            <strong>{PERM_DESC[form.codePermission].split('：')[0]}</strong>
                            {PERM_DESC[form.codePermission].includes('：')
                              ? `：${PERM_DESC[form.codePermission].split('：').slice(1).join('：')}`
                              : ''}
                          </div>
                          {form.codePermission === 'danger-full-access' ? (
                            <div className="ws-danger-banner" role="alert">
                              <strong>写文件、删除和 shell 会立刻执行。</strong>
                              不再弹出确认卡。仍只能动已绑定目录里的路径，越界会被拒绝。
                            </div>
                          ) : null}
                          <div className="inset-section-title" style={{ marginTop: 12 }}>编码工具</div>
                          <div className="inset-group ws-tools-matrix">
                            <div className="inset-row">
                              <span>list / read / grep</span>
                              <span className="tag tag-ok">可用</span>
                            </div>
                            <div className="inset-row">
                              <span>{form.codePermission === 'danger-full-access' ? '写文件' : '写文件（diff 确认）'}</span>
                              <span className={codeGateTag(form.codePermission).className}>{codeGateTag(form.codePermission).text}</span>
                            </div>
                            <div className="inset-row">
                              <span>{form.codePermission === 'danger-full-access' ? 'shell' : 'shell（命令确认）'}</span>
                              <span className={codeGateTag(form.codePermission).className}>{codeGateTag(form.codePermission).text}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {form.id ? (
                      <div className="field">
                        <label>长期记忆</label>
                        <div className="inset-group" style={{ padding: '0 12px' }}>
                          {memories.length === 0 ? <p className="help">还没有跨会话记忆。</p> : null}
                          <div className="skill-attached-list ltm-preview-list">
                            {memories.slice(0, 6).map((item) => (
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
                        <div className="help" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span>跨会话持久事实；与「会话摘要」不同。共 {memories.length} 条。</span>
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            onClick={() => {
                              const friendId = form.id
                              if (!friendId) return
                              const fact = window.prompt('添加一条好友长期记忆：')
                              if (!fact?.trim()) return
                              void requestJson<{ ok: true; memory: LongTermMemory }>('/api/long-term-memories', {
                                method: 'POST',
                                body: JSON.stringify({ scope: 'friend', ownerId: friendId, fact: fact.trim(), source: 'manual' }),
                              }).then((payload) => setMemories((current) => [payload.memory, ...current]))
                            }}
                          >
                            添加
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {form.id ? (
                      <div className="field">
                        <label>已挂技能</label>
                        <div className="inset-group" style={{ padding: '0 12px' }}>
                          {skills.length === 0 ? <p className="help">还没有挂到这位好友的技能。</p> : null}
                          <div className="skill-attached-list">
                            {skills.map((skill) => (
                              <details key={skill.id} className="skill-attached-item skill-preview">
                                <summary className="skill-preview-sum">
                                  <div className="sk-icon">技</div>
                                  <div className="sk-meta">
                                    <div className="sk-name">{skill.name}</div>
                                    <div className="sk-desc">{skill.description || '手工保存 / 会话抽技能'}</div>
                                  </div>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      const friendId = form.id
                                      if (!friendId) return
                                      void requestJson(`/api/skills/${encodeURIComponent(skill.id)}?friendId=${encodeURIComponent(friendId)}`, {
                                        method: 'DELETE',
                                      }).then(() => setSkills((current) => current.filter((item) => item.id !== skill.id)))
                                    }}
                                  >
                                    移除
                                  </button>
                                </summary>
                                <ol className="steps-preview" style={{ margin: '8px 0 4px' }}>
                                  {(skill.steps && skill.steps.length > 0
                                    ? skill.steps
                                    : (skill.body || '').split('\n').filter(Boolean).slice(0, 8)
                                  ).map((step, index) => (
                                    <li key={`${skill.id}-${index}`}>
                                      <span className="step-n">{index + 1}</span>
                                      <span>{step.replace(/^\s*\d+[\.、)]\s*/, '')}</span>
                                    </li>
                                  ))}
                                </ol>
                              </details>
                            ))}
                          </div>
                        </div>
                        <div className="help">会话抽技能 /「建议保存为技能」确认后出现在此；点开可预览名称与步骤。未确认不落库。</div>
                      </div>
                    ) : null}
                    {error ? <p className="form-error">{error}</p> : null}
                  </div>
                </div>
                <div className="card-ft">
                  <button className="btn btn-secondary" type="button" disabled={pending} onClick={cancelEdit}>
                    取消
                  </button>
                  <button className="btn" type="submit" disabled={pending || form.name.trim().length === 0}>
                    {pending ? '保存中' : '保存'}
                  </button>
                  {form.id && onOpenChat ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        const current = form
                        if (!current.id) return
                        void persist().then((ok) => {
                          if (ok) onOpenChat({ id: current.id!, name: current.name })
                        })
                      }}
                    >
                      保存并去聊天
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <p className="empty">选一个好友，或新建一个。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )

  function formFrom(friend: Friend): FormState {
    return {
      id: friend.id,
      name: friend.name,
      description: friend.description,
      systemPrompt: friend.systemPrompt,
      avatar: friend.avatar,
      providerId: friend.providerId,
      defaultModelId: friend.defaultModelId ?? '',
      workspacePath: friend.workspacePath ?? '',
      codePermission: friend.codePermission ?? 'workspace-write',
      visionEnabled: Boolean(friend.vision?.enabled),
      visionProviderId: friend.vision?.providerId ?? friend.providerId,
      visionModelId: friend.vision?.modelId ?? '',
    }
  }
}
