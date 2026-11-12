/**
 * 启动时读出页面需要的第一屏。种子在更早的 open 阶段已经跑过。
 */

import type { ConversationCard, Friend, Provider } from '../domain/types.ts'
import type { Repos } from '../storage/repos/index.ts'
import { DB_NAME, DB_VERSION } from '../storage/schema.ts'
import { listConversations } from './conversations.ts'
import { listProviders } from './providers.ts'
import { listFriends } from './friends.ts'

export type WorkbenchSnapshot = {
  db: { name: string; version: number }
  providers: Provider[]
  friends: Friend[]
  conversations: ConversationCard[]
}

/** @param repos 本地仓库 */
export async function loadWorkbench(repos: Repos): Promise<WorkbenchSnapshot> {
  const [providers, friends, conversations] = await Promise.all([
    listProviders(repos),
    listFriends(repos),
    listConversations(repos),
  ])
  const cards = await Promise.all(conversations.map((conversation) => withPreview(repos, conversation)))
  return {
    db: { name: DB_NAME, version: DB_VERSION },
    providers,
    friends,
    conversations: cards,
  }
}

async function withPreview(
  repos: Repos,
  conversation: Awaited<ReturnType<typeof listConversations>>[number],
): Promise<ConversationCard> {
  const messages = await repos.messages.listByConversation(conversation.id)
  const last = [...messages].reverse().find((item) => item.content.trim() || (item.attachments?.length ?? 0) > 0)
  return { ...conversation, preview: last ? clipPreview(last) : '' }
}

function clipPreview(message: { content: string; attachments?: { kind: string; name: string }[] }): string {
  const text = message.content.replace(/\s+/g, ' ').trim()
  const attachments = message.attachments ?? []
  let prefix = ''
  if (attachments.length) {
    const hasImage = attachments.some((item) => item.kind === 'image')
    const hasFile = attachments.some((item) => item.kind !== 'image')
    if (hasImage && hasFile) prefix = '[图片/附件] '
    else if (hasImage) prefix = '[图片] '
    else prefix = '[附件] '
  }
  const flat = `${prefix}${text}`.trim() || prefix.trim()
  return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat
}
