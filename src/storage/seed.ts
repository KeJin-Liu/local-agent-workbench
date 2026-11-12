/**
 * 冷启动种子：Ollama 本地提供方，以及带默认头像的「群主」模板。
 * 表里已经有记录时不覆盖，避免冲掉用户改过的地址或人设。
 */

import { DEFAULT_FRIEND_AVATAR, type ApiKeyPolicy, type Conversation, type Friend, type Provider } from '../domain/types.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from './database.ts'
import {
  CURSOR_BASE_URL,
  CURSOR_PRESET_MODELS,
  CURSOR_PROVIDER_ID,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_PROVIDER_ID,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  DEFAULT_OLLAMA_BASE_URL,
  LMSTUDIO_BASE_URL,
  LMSTUDIO_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  OPENAI_BASE_URL,
  OPENAI_PROVIDER_ID,
  OWNER_FRIEND_ID,
} from './schema.ts'

/** 预设提供方。云端没有密钥时先停用，避免误打到公网。 */
export function createPresetProviders(now: number): Provider[] {
  return [
    preset(now, {
      id: OLLAMA_PROVIDER_ID,
      name: 'Ollama 本地',
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      apiKeyPolicy: 'none',
      enabled: true,
    }),
    preset(now, {
      id: LMSTUDIO_PROVIDER_ID,
      name: 'LM Studio 本地',
      baseUrl: LMSTUDIO_BASE_URL,
      apiKeyPolicy: 'optional',
      enabled: true,
    }),
    preset(now, {
      id: OPENAI_PROVIDER_ID,
      name: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      apiKeyPolicy: 'required',
      enabled: false,
    }),
    preset(now, {
      id: DEEPSEEK_PROVIDER_ID,
      name: 'DeepSeek',
      baseUrl: DEEPSEEK_BASE_URL,
      apiKeyPolicy: 'required',
      enabled: false,
    }),
    preset(now, {
      id: DASHSCOPE_PROVIDER_ID,
      name: '阿里云百炼',
      baseUrl: DASHSCOPE_BASE_URL,
      apiKeyPolicy: 'required',
      enabled: false,
      defaultModel: 'qwen-plus',
    }),
    preset(now, {
      id: CURSOR_PROVIDER_ID,
      name: 'Cursor',
      baseUrl: CURSOR_BASE_URL,
      apiKeyPolicy: 'required',
      enabled: false,
      defaultModel: 'composer-2.5',
      probedModels: [...CURSOR_PRESET_MODELS],
    }),
  ]
}

function preset(
  now: number,
  input: {
    id: string
    name: string
    baseUrl: string
    apiKeyPolicy: ApiKeyPolicy
    enabled: boolean
    defaultModel?: string
    probedModels?: string[]
  },
): Provider {
  return {
    ...input,
    kind: 'openai-compatible',
    createdAt: now,
    updatedAt: now,
  }
}

/** @deprecated 使用 createPresetProviders。保留给旧测试名字。 */
export function createOllamaProvider(now: number): Provider {
  return createPresetProviders(now)[0]!
}

/**
 * 默认好友「群主」。id 固定为 `role-owner`：历史冷启动用过这个字符串，保留它以免把已有记录拆成另一条。
 * 语义是默认好友 / 群主，不是角色实体。群聊用 isOwnerTemplate 找到它。
 */
export function createOwnerFriend(now: number): Friend {
  return {
    id: OWNER_FRIEND_ID,
    name: '群主',
    description:
      '群聊里负责听清目标、拆开步骤、点名其他好友，并在结束时收口。单聊阶段也可以把这个模板当作默认助手。',
    systemPrompt: [
      '你是本地工作台里的群主。',
      '先听清用户要的结果，再把任务拆成可以执行的小步。',
      '信息不够时，只追问一个最关键的问题。',
      '需要其他好友时，用明确的点名说明谁做什么。',
      '结束时用几句话收口：做了什么、还缺什么。',
      '不要假装已经调用了外部工具，也不要假装看过这台电脑以外的数据。',
    ].join('\n'),
    isOwnerTemplate: true,
    avatar: { ...DEFAULT_FRIEND_AVATAR },
    providerId: OLLAMA_PROVIDER_ID,
    createdAt: now,
    updatedAt: now,
  }
}

export type SeedResult = {
  providersSeeded: number
  friendsSeeded: boolean
  avatarsBackfilled: number
  friendsBackfilled: number
}

/**
 * 每张表各自判断是否为空。只清空好友时，下次启动会把群主补回来，已有的提供方保持不动。
 */
export async function seedIfEmpty(database: WorkbenchDatabase): Promise<SeedResult> {
  const result = await database.update((draft) => {
    const now = Date.now()
    let providersSeeded = 0
    let friendsSeeded = false
    let avatarsBackfilled = 0
    let friendsBackfilled = 0
    for (const presetProvider of createPresetProviders(now)) {
      if (draft.stores.providers.some((item) => item.id === presetProvider.id)) continue
      // 只补缺的预设，已有同 id 的记录（包括用户改过的地址）保持不动。
      draft.stores.providers.push(presetProvider)
      providersSeeded += 1
    }
    for (const provider of draft.stores.providers) {
      if (!provider.apiKeyPolicy) provider.apiKeyPolicy = policyFor(provider.id)
      if (typeof provider.enabled !== 'boolean') {
        const linked = Boolean(provider.vaultEntryId || (provider as { apiKeySecretId?: string }).apiKeySecretId)
        provider.enabled = provider.apiKeyPolicy === 'required' ? linked : true
      }
    }
    if (draft.stores.friends.length === 0) {
      const owner = createOwnerFriend(now)
      draft.stores.friends.push(owner)
      const welcome: Conversation = {
        id: crypto.randomUUID(),
        title: owner.name,
        kind: 'direct',
        friendIds: [owner.id],
        providerId: owner.providerId,
        lineageId: `friend:${owner.id}`,
        createdAt: now,
        updatedAt: now,
      }
      draft.stores.conversations.push(welcome)
      friendsSeeded = true
    }
    for (const friend of draft.stores.friends) {
      if (friend.avatar?.kind !== 'default' && friend.avatar?.kind !== 'upload') {
        friend.avatar = { ...DEFAULT_FRIEND_AVATAR }
        avatarsBackfilled += 1
      }
      const legacy = friend as Friend & { model?: string }
      if (!friend.defaultModelId && legacy.model) {
        friend.defaultModelId = legacy.model
        delete legacy.model
        friendsBackfilled += 1
      }
      if (!friend.providerId) {
        friend.providerId = OLLAMA_PROVIDER_ID
        friendsBackfilled += 1
      }
    }
    return { providersSeeded, friendsSeeded, avatarsBackfilled, friendsBackfilled }
  })
  log('info', 'storage', '检查种子', result)
  return result
}

function policyFor(id: string): ApiKeyPolicy {
  if (
    id === OPENAI_PROVIDER_ID ||
    id === DEEPSEEK_PROVIDER_ID ||
    id === DASHSCOPE_PROVIDER_ID ||
    id === CURSOR_PROVIDER_ID
  ) {
    return 'required'
  }
  if (id === LMSTUDIO_PROVIDER_ID) return 'optional'
  if (id === OLLAMA_PROVIDER_ID) return 'none'
  return 'optional'
}
