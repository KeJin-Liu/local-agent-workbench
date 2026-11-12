/**
 * QQ 式主壳：窄图标栏、会话列表、中间聊天。配置只在图标打开的二级页里。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ConversationCard, Friend, FriendAvatar, PublicProvider, PublicSecret } from '../domain/types.ts'
import { OWNER_FRIEND_ID } from '../storage/schema.ts'
import { log } from '../logger.ts'
import { requestJson, type DefaultAvatar, type WorkbenchPayload } from './api.ts'
import { ConversationPane } from './conversation-pane.tsx'
import { ProviderSettings } from './provider-settings.tsx'
import { FriendPanel } from './friend-panel.tsx'
import { TasksPage } from './tasks-page.tsx'
import { ConversationList, NewChatDialog } from './conversation-list.tsx'
import { SettingsHub, SettingsPage } from './settings-page.tsx'
import { MailSettingsPage } from './mail-settings-page.tsx'
import { McpShell } from './mcp-pages.tsx'

type Page = 'chat' | 'friends' | 'mcp' | 'mcp-market' | 'mcp-resources' | 'vault' | 'tasks' | 'settings' | 'providers' | 'mail'

export function App() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [providers, setProviders] = useState<PublicProvider[]>([])
  const [secrets, setSecrets] = useState<PublicSecret[]>([])
  const [friends, setFriends] = useState<Friend[]>([])
  const [conversations, setConversations] = useState<ConversationCard[]>([])
  const [defaults, setDefaults] = useState<DefaultAvatar[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState<Page>('chat')
  const [dialog, setDialog] = useState<'group' | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [friendFocus, setFriendFocus] = useState<string | null>(null)
  const [friendCreateToken, setFriendCreateToken] = useState(0)
  const [mcpResourceServerId, setMcpResourceServerId] = useState<string | null>(null)
  const [composerInsert, setComposerInsert] = useState<string | null>(null)
  const [chatToast, setChatToast] = useState('')
  const [sendWaitSeconds, setSendWaitSeconds] = useState(5)
  useEffect(() => {
    if (!chatToast) return
    const timer = setTimeout(() => setChatToast(''), 2200)
    return () => clearTimeout(timer)
  }, [chatToast])

  const apply = useCallback((payload: WorkbenchPayload, keepSelection: string | null) => {
    setProviders(payload.providers)
    setFriends(payload.friends)
    setConversations(payload.conversations)
    if (payload.settings?.sendWaitSeconds) setSendWaitSeconds(payload.settings.sendWaitSeconds)
    setSelectedId((current) => {
      const preferred = keepSelection ?? current
      if (preferred && payload.conversations.some((item) => item.id === preferred)) return preferred
      const ownerChat = payload.conversations.find(
        (item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === OWNER_FRIEND_ID,
      )
      return ownerChat?.id ?? null
    })
  }, [])

  const refresh = useCallback(
    async (keepSelection?: string) => {
      const [payload, vaultPayload] = await Promise.all([
        requestJson<WorkbenchPayload>('/api/workbench'),
        requestJson<{ ok: true; secrets: PublicSecret[] }>('/api/vault'),
      ])
      apply(payload, keepSelection ?? null)
      setSecrets(vaultPayload.secrets)
    },
    [apply],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [payload, avatarPayload, vaultPayload] = await Promise.all([
          requestJson<WorkbenchPayload>('/api/workbench'),
          requestJson<{ ok: true; avatars: DefaultAvatar[] }>('/api/avatars/defaults'),
          requestJson<{ ok: true; secrets: PublicSecret[] }>('/api/vault'),
        ])
        if (cancelled) return
        apply(payload, null)
        setDefaults(avatarPayload.avatars)
        setSecrets(vaultPayload.secrets)
        setStatus('ready')
        const ownerChat = payload.conversations.find(
          (item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === OWNER_FRIEND_ID,
        )
        if (!ownerChat && payload.friends.some((friend) => friend.id === OWNER_FRIEND_ID)) {
          try {
            const created = await requestJson<{ ok: true; conversation: ConversationCard }>('/api/conversations', {
              method: 'POST',
              body: JSON.stringify({ title: '群主', friendIds: [OWNER_FRIEND_ID], kind: 'direct' }),
            })
            if (!cancelled) {
              apply(
                {
                  ...payload,
                  conversations: [created.conversation, ...payload.conversations],
                },
                created.conversation.id,
              )
            }
          } catch (cause) {
            log('warn', 'ui', '默认打开群主失败', {
              error: cause instanceof Error ? cause.message : String(cause),
            })
          }
        }
        log('info', 'ui', '打开工作台', { friends: payload.friends.length, conversations: payload.conversations.length })
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : '本地库打开失败'
        setError(message)
        setStatus('error')
        log('error', 'ui', '打开工作台失败', { error: message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [apply])

  if (status === 'loading') {
    return (
      <StatusScreen title="正在打开本地库">
        读取 data 目录里的 agent_workbench，并在空库时种入 Ollama 和群主好友。
      </StatusScreen>
    )
  }
  if (status === 'error') {
    return <StatusScreen title="本地库没有打开">{error} 请确认这个 Node 进程仍在运行。</StatusScreen>
  }

  const selected = conversations.find((item) => item.id === selectedId) ?? null
  // 群聊默认发言人是群主；@ 点名由 ConversationPane 自己解析。
  const speaker =
    friends.find(
      (friend) =>
        selected?.kind === 'group' &&
        friend.isOwnerTemplate &&
        Boolean(selected.friendIds.includes(friend.id)),
    ) ?? friends.find((friend) => friend.id === selected?.friendIds[0])
  const provider = providers.find(
    (item) =>
      item.id ===
      (selected?.kind === 'group'
        ? selected.providerId || speaker?.providerId
        : speaker?.providerId || selected?.providerId),
  )
  async function createChat(input: {
    title: string
    friendIds: string[]
    kind: 'direct' | 'group'
    model?: string
    avatar?: FriendAvatar | null
  }) {
    const payload = await requestJson<{ ok: true; conversation: ConversationCard }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!sameAvatar(input.avatar, payload.conversation.avatar)) {
      throw new Error('群头像没有写入本地库：当前本地工作台进程还没加载这条改动。重启本地工作台（pnpm dev / pnpm start）后再试，data/ 里的数据不会动。')
    }
    await refresh(payload.conversation.id)
    setDialog(null)
    setPage('chat')
  }

  const railKey =
    page === 'providers' || page === 'mail'
      ? 'settings'
      : page === 'mcp-market' || page === 'mcp-resources'
        ? 'mcp'
        : page

  return (
    <div className="app" data-page={page} data-chat={selectedId ? 'open' : 'closed'}>
      <IconRail page={railKey} onChange={setPage} />
      {page === 'chat' ? (
        <>
          <ConversationList
            conversations={conversations}
            friends={friends}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id)
              setPage('chat')
            }}
            onOpenFriend={async (friend) => {
              const existing = conversations.find(
                (item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === friend.id,
              )
              if (existing) {
                setSelectedId(existing.id)
                setPage('chat')
                return
              }
              await createChat({ title: friend.name, friendIds: [friend.id], kind: 'direct' })
            }}
            onCreateFriend={() => {
              setFriendFocus(null)
              setFriendCreateToken((value) => value + 1)
              setPage('friends')
            }}
            onCreateGroup={() => {
              setEditingGroupId(null)
              setDialog('group')
            }}
          />
          <ConversationPane
            conversation={selected}
            provider={provider}
            friends={friends}
            providers={providers}
            sendWaitSeconds={sendWaitSeconds}
            insertText={composerInsert}
            conversations={conversations}
            onInsertConsumed={() => setComposerInsert(null)}
            onOpenProviders={() => setPage('providers')}
            onOpenSettings={() => {
              if (!selected) return
              if (selected.kind === 'group') {
                setEditingGroupId(selected.id)
                setDialog('group')
                return
              }
              const friendId = selected.friendIds[0]
              if (!friendId) return
              setFriendFocus(friendId)
              setPage('friends')
            }}
            onBack={() => setSelectedId(null)}
            onSwitchConversation={(id) => setSelectedId(id)}
            onActivity={() => void refresh(selectedId ?? undefined)}
            onFreshThread={async (id) => {
              await refresh(id)
            }}
          />
        </>
      ) : null}
      {page === 'friends' ? (
        <FriendPanel
          friends={friends}
          defaults={defaults}
          providers={providers}
          focusId={friendFocus}
          createToken={friendCreateToken}
          onSaved={async () => refresh(selectedId ?? undefined)}
          onCancel={() => {
            // 好友管理是聊天里的二级页：取消不保存，直接回到聊天窗口。
            setFriendFocus(null)
            setFriendCreateToken(0)
            setPage('chat')
          }}
          onOpenChat={async (friend) => {
            const existing = conversations.find(
              (item) => item.kind === 'direct' && item.friendIds.length === 1 && item.friendIds[0] === friend.id,
            )
            if (existing) {
              setSelectedId(existing.id)
              setPage('chat')
              return
            }
            await createChat({ title: friend.name, friendIds: [friend.id], kind: 'direct' })
          }}
        />
      ) : null}
      {(page === 'mcp' || page === 'mcp-market' || page === 'mcp-resources') ? (
        <McpShell
          section={page === 'mcp-market' ? 'market' : page === 'mcp-resources' ? 'resources' : 'configured'}
          secrets={secrets}
          friends={friends}
          resourceServerId={mcpResourceServerId}
          onSection={(section) => {
            if (section === 'market') setPage('mcp-market')
            else if (section === 'resources') setPage('mcp-resources')
            else setPage('mcp')
          }}
          onOpenResources={(serverId) => {
            setMcpResourceServerId(serverId)
            setPage('mcp-resources')
          }}
          onInsertComposer={(text) => {
            setComposerInsert(text)
            setChatToast('已排队插入当前对话输入框')
            setPage('chat')
          }}
          onBackChat={() => setPage('chat')}
        />
      ) : null}
      {page === 'vault' ? (
        <SettingsPage section="vault" secrets={secrets} onChanged={async () => refresh(selectedId ?? undefined)} />
      ) : null}
      {chatToast ? (
        <div className="chat-toast is-show" role="status">
          {chatToast}
        </div>
      ) : null}
      {page === 'tasks' ? (
        <TasksPage friends={friends} conversations={conversations} onOpenMail={() => setPage('mail')} />
      ) : null}
      {page === 'settings' ? (
        <SettingsHub
          onOpen={setPage}
          sendWaitSeconds={sendWaitSeconds}
          onSendWaitSecondsChange={async (seconds) => {
            const payload = await requestJson<{ ok: true; settings: { sendWaitSeconds: number } }>('/api/settings', {
              method: 'PUT',
              body: JSON.stringify({ sendWaitSeconds: seconds }),
            })
            setSendWaitSeconds(payload.settings.sendWaitSeconds)
          }}
        />
      ) : null}
      {page === 'mail' ? (
        <MailSettingsPage
          secrets={secrets}
          onBack={() => setPage('settings')}
          onOpenVault={() => setPage('vault')}
          onOpenTasks={() => setPage('tasks')}
        />
      ) : null}
      {page === 'providers' ? (
        <ProviderSettings
          providers={providers}
          secrets={secrets}
          onBack={() => setPage('settings')}
          onSaved={async () => refresh(selectedId ?? undefined)}
        />
      ) : null}
      {dialog === 'group' && page === 'chat' ? (
        <NewChatDialog
          key={editingGroupId ?? 'new-group'}
          friends={friends}
          providers={providers}
          conversationId={editingGroupId ?? undefined}
          projectOwnerId={
            editingGroupId && selected?.id === editingGroupId
              ? selected.lineageId || selected.id
              : undefined
          }
          seed={
            editingGroupId && selected?.id === editingGroupId
              ? {
                  title: selected.title,
                  friendIds: selected.friendIds,
                  model: selected.model,
                  avatar: selected.avatar,
                  workspaceRoot: selected.workspaceRoot,
                  memberWorkspaces: selected.memberWorkspaces,
                  memberPrompts: selected.memberPrompts,
                  memberModels: selected.memberModels,
                  archived: selected.archived,
                }
              : undefined
          }
          onPersisted={
            editingGroupId
              ? async () => {
                  await refresh(editingGroupId)
                }
              : undefined
          }
          onClose={() => {
            setDialog(null)
            setEditingGroupId(null)
          }}
          onCreate={async (input) => {
            if (editingGroupId) {
              const saved = await requestJson<{ ok: true; conversation: ConversationCard }>(
                `/api/conversations/${encodeURIComponent(editingGroupId)}`,
                {
                  method: 'PUT',
                  body: JSON.stringify(input),
                },
              )
              if (!sameAvatar(input.avatar, saved.conversation.avatar)) {
                throw new Error('群头像没有写入本地库：当前本地工作台进程还没加载这条改动。重启本地工作台（pnpm dev / pnpm start）后再试，data/ 里的数据不会动。')
              }
              await refresh(editingGroupId)
              setDialog(null)
              setEditingGroupId(null)
              setPage('chat')
              return
            }
            await createChat(input)
          }}
        />
      ) : null}
    </div>
  )
}

function IconRail({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail-avatar" title="我">
        我
      </div>
      <RailButton page="chat" current={page} label="会话" onChange={onChange}>
        <svg className="rail-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M4 3.75A2.75 2.75 0 0 0 1.25 6.5v8A2.75 2.75 0 0 0 4 17.25h1.75V20.5a.75.75 0 0 0 1.22.58L11.3 17.25H20A2.75 2.75 0 0 0 22.75 14.5v-8A2.75 2.75 0 0 0 20 3.75H4zm3.25 6a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4.75 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4.75 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z" />
        </svg>
      </RailButton>
      <RailButton page="mcp" current={page} label="MCP" onChange={onChange}>
        <svg className="rail-svg rail-svg-mcp" viewBox="0 0 24 24" aria-hidden="true">
          <g transform="rotate(-35 12 12)" fill="none" stroke="#A8AEB8" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <rect x="8" y="4.5" width="8" height="4" rx="1.2" fill="#C5CAD3" stroke="#9AA1AC" />
            <path d="M9.2 8.5h5.6v5.2a2.8 2.8 0 0 1-2.8 2.8h0a2.8 2.8 0 0 1-2.8-2.8V8.5z" fill="#B0B6C0" stroke="#8E959F" />
            <path d="M10.3 16.5v3M13.7 16.5v3" />
            <path d="M7.2 10.2H5.5M18.5 10.2h-1.7" />
          </g>
        </svg>
      </RailButton>
      <RailButton page="vault" current={page} label="密码库" onChange={onChange}>
        <svg className="rail-svg rail-svg-key" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#E8B84A" d="M14.5 3.5a5 5 0 0 0-4.74 6.6L3.2 16.66a1.2 1.2 0 0 0-.02 1.7l1.46 1.46a1.2 1.2 0 0 0 1.7 0l.7-.7.9.9a1 1 0 0 0 1.42 0l.9-.9.7.7a1 1 0 0 0 1.42 0l1.2-1.2a1.2 1.2 0 0 0 0-1.7l-3.3-3.3A5 5 0 0 0 14.5 3.5zm0 2.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z" />
        </svg>
      </RailButton>
      <RailButton page="tasks" current={page} label="自动化任务" onChange={onChange}>
        <svg className="rail-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M7 3.75A.75.75 0 0 1 7.75 3h.5a.75.75 0 0 1 .75.75V5h6.5V3.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 .75.75V5h1.5A2.75 2.75 0 0 1 21.5 7.75v11A2.75 2.75 0 0 1 18.75 21.5H5.25A2.75 2.75 0 0 1 2.5 18.75v-11A2.75 2.75 0 0 1 5.25 5H6.75V3.75zM4.5 9.5v9.25c0 .69.56 1.25 1.25 1.25h13.5c.69 0 1.25-.56 1.25-1.25V9.5H4.5zm3.25 3.25h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5zm0 3.5h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5z"
          />
        </svg>
      </RailButton>
      <div className="rail-spacer" />
      <RailButton page="settings" current={page} label="设置" onChange={onChange}>
        <svg className="rail-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.22 1.12-.54 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
        </svg>
      </RailButton>
    </nav>
  )
}

function RailButton({
  page,
  current,
  label,
  onChange,
  children,
}: {
  page: Page
  current: Page
  label: string
  onChange: (page: Page) => void
  children: ReactNode
}) {
  const active = page === current
  return (
    <button type="button" className={active ? 'rail-item is-active' : 'rail-item'} title={label} aria-label={label} aria-current={active ? 'page' : undefined} onClick={() => onChange(page)}>
      {children}
    </button>
  )
}

function StatusScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="status-screen">
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  )
}

function sameAvatar(expected: FriendAvatar | null | undefined, saved: FriendAvatar | undefined): boolean {
  if (!expected) return !saved
  return Boolean(saved && saved.kind === expected.kind && saved.id === expected.id)
}
