/**
 * 命名密钥的增删改查。列表和日志只有名称和类型，明文只在 reveal 里短暂停一下。
 */

import type { McpEnvBinding, PublicSecret, SecretKind, VaultSecretRecord, WorkbenchDocument } from '../domain/types.ts'
import { AppError } from '../app/errors.ts'
import { log } from '../logger.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import { decryptJson, encryptJson, loadVaultKey } from './crypto.ts'

export type SecretInput = {
  id?: string
  name: string
  kind: SecretKind
  username?: string
  apiKey?: string
  password?: string
}

export type RevealedSecret = {
  apiKey?: string
  password?: string
}

type SecretBody = {
  apiKey?: string
  password?: string
}

export type VaultService = {
  list: () => Promise<PublicSecret[]>
  upsert: (input: SecretInput) => Promise<PublicSecret>
  /** 加密一条记录，但不写入。迁移和提供方保存要和别的改动放进同一次 update。 */
  stage: (input: SecretInput) => Promise<VaultSecretRecord>
  remove: (id: string) => Promise<void>
  reveal: (id: string) => Promise<RevealedSecret | undefined>
}

/** @param keyFile data/vault.key */
export function createVault(database: WorkbenchDatabase, keyFile: string): VaultService {
  let keyPromise: Promise<Buffer> | null = null
  const key = () => {
    keyPromise ??= loadVaultKey(keyFile)
    return keyPromise
  }

  return {
    async list() {
      const document = await database.read()
      return document.stores.secrets.map(toPublic)
    },

    async stage(input) {
      const existing = input.id
        ? (await database.read()).stores.secrets.find((item) => item.id === input.id)
        : undefined
      const previous = existing ? decryptJson<SecretBody>(await key(), existing.ciphertext) : {}
      return buildRecord(await key(), input, existing, previous)
    },

    async upsert(input) {
      const existing = input.id
        ? (await database.read()).stores.secrets.find((item) => item.id === input.id)
        : undefined
      const previous = existing ? decryptJson<SecretBody>(await key(), existing.ciphertext) : {}
      const record = buildRecord(await key(), input, existing, previous)
      await database.update((draft) => {
        const index = draft.stores.secrets.findIndex((item) => item.id === record.id)
        if (index === -1) draft.stores.secrets.push(record)
        else draft.stores.secrets[index] = record
      })
      log('info', 'vault', existing ? '更新密钥' : '新建密钥', { id: record.id, kind: record.kind })
      return toPublic(record)
    },

    async remove(id) {
      await database.update((draft) => {
        draft.stores.secrets = draft.stores.secrets.filter((item) => item.id !== id)
        for (const provider of draft.stores.providers) {
          if (provider.vaultEntryId === id) delete provider.vaultEntryId
        }
        for (const server of draft.stores.mcpServers) {
          for (const binding of [...(server.env ?? []), ...(server.headers ?? [])]) {
            if (binding.vaultEntryId === id) delete binding.vaultEntryId
          }
        }
      })
      log('info', 'vault', '删除密钥', { id })
    },

    async reveal(id) {
      const document = await database.read()
      const record = document.stores.secrets.find((item) => item.id === id)
      if (!record) return undefined
      return decryptJson<RevealedSecret>(await key(), record.ciphertext)
    },
  }
}

function buildRecord(
  key: Buffer,
  input: SecretInput,
  existing: VaultSecretRecord | undefined,
  previous: SecretBody,
): VaultSecretRecord {
  const name = input.name.trim()
  if (!name) throw new AppError(400, '密钥名称不能为空。')
  if (input.kind !== 'api-key' && input.kind !== 'login') throw new AppError(400, '密钥类型不正确。')
  const apiKey = input.apiKey?.trim() || previous.apiKey
  const password = input.password?.trim() || previous.password
  if (input.kind === 'api-key' && !apiKey) throw new AppError(400, 'API Key 不能为空。')
  if (input.kind === 'login' && !password) throw new AppError(400, '密码不能为空。')
  const now = Date.now()
  return {
    id: existing?.id ?? input.id ?? crypto.randomUUID(),
    name,
    kind: input.kind,
    ciphertext: encryptJson(key, {
      ...(apiKey ? { apiKey } : {}),
      ...(password ? { password } : {}),
    }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(input.username?.trim() || existing?.username
      ? { username: input.username?.trim() || existing?.username }
      : {}),
  }
}

type LegacyProvider = { apiKey?: string; apiKeySecretId?: string; vaultEntryId?: string; id: string; name: string }
type LegacyBinding = McpEnvBinding & { secretId?: string }

/**
 * 把提供方上残留的明文 apiKey 收进保险库，并改成 vaultEntryId。
 * 必须在第一次会改写本地库的操作之前调用，否则落盘擦除会把明文直接丢掉。
 */
export async function migratePlaintextSecrets(
  database: WorkbenchDatabase,
  vault: VaultService,
): Promise<{ moved: number }> {
  const document = await database.read()
  if (!needsSecretRewrite(document)) return { moved: 0 }
  const staged: Array<{ providerId: string; record: VaultSecretRecord }> = []
  for (const provider of document.stores.providers) {
    const legacy = provider as LegacyProvider
    const apiKey = typeof legacy.apiKey === 'string' ? legacy.apiKey.trim() : ''
    if (!apiKey) continue
    const id = provider.vaultEntryId || legacy.apiKeySecretId || crypto.randomUUID()
    const known = document.stores.secrets.find((item) => item.id === id)
    staged.push({
      providerId: provider.id,
      record: await vault.stage({
        id,
        name: known?.name ?? `${provider.name} 的密钥`,
        kind: 'api-key',
        apiKey,
        ...(known?.username ? { username: known.username } : {}),
      }),
    })
  }
  await database.update((draft) => {
    for (const item of staged) {
      const index = draft.stores.secrets.findIndex((secret) => secret.id === item.record.id)
      if (index === -1) draft.stores.secrets.push(item.record)
      else draft.stores.secrets[index] = { ...draft.stores.secrets[index], ...item.record, createdAt: draft.stores.secrets[index]!.createdAt }
    }
    for (const provider of draft.stores.providers) {
      const legacy = provider as LegacyProvider
      const moved = staged.find((item) => item.providerId === provider.id)
      if (moved) provider.vaultEntryId = moved.record.id
      else if (!provider.vaultEntryId && legacy.apiKeySecretId) provider.vaultEntryId = legacy.apiKeySecretId
      delete legacy.apiKey
      delete legacy.apiKeySecretId
    }
    for (const server of draft.stores.mcpServers) {
      server.env ??= []
      server.headers ??= []
      for (const binding of [...server.env, ...server.headers]) {
        const legacy = binding as LegacyBinding
        if (!binding.vaultEntryId && legacy.secretId) binding.vaultEntryId = legacy.secretId
        delete legacy.secretId
      }
    }
  })
  log('info', 'vault', '迁走明文密钥', { moved: staged.length })
  return { moved: staged.length }
}

function needsSecretRewrite(document: WorkbenchDocument): boolean {
  for (const provider of document.stores.providers) {
    const legacy = provider as LegacyProvider
    if (legacy.apiKey || legacy.apiKeySecretId) return true
  }
  for (const server of document.stores.mcpServers) {
    for (const binding of [...(server.env ?? []), ...(server.headers ?? [])]) {
      if ((binding as LegacyBinding).secretId) return true
    }
  }
  return false
}

function toPublic(record: VaultSecretRecord): PublicSecret {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    updatedAt: record.updatedAt,
    ...(record.username ? { username: record.username } : {}),
  }
}
