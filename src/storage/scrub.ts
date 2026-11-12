/**
 * 落盘前的最后一道闸。提供方上不允许留下明文 apiKey。
 * 旧字段 apiKeySecretId / secretId 在这里收成 vaultEntryId。
 */

import type { McpEnvBinding, Provider, WorkbenchDocument } from '../domain/types.ts'

type LegacyProvider = Provider & { apiKey?: string; apiKeySecretId?: string }
type LegacyBinding = McpEnvBinding & { secretId?: string }

/** 就地修改即将写入磁盘的文档。调用方不应再从这份对象里读明文密钥。 */
export function scrubPersistedSecrets(document: WorkbenchDocument): void {
  for (const provider of document.stores.providers) {
    const legacy = provider as LegacyProvider
    if (!provider.vaultEntryId && legacy.apiKeySecretId) provider.vaultEntryId = legacy.apiKeySecretId
    delete legacy.apiKey
    delete legacy.apiKeySecretId
  }
  for (const server of document.stores.mcpServers) {
    server.env ??= []
    server.headers ??= []
    for (const binding of [...server.env, ...server.headers]) adoptVaultEntry(binding)
  }
}

function adoptVaultEntry(binding: McpEnvBinding): void {
  const legacy = binding as LegacyBinding
  if (!binding.vaultEntryId && legacy.secretId) binding.vaultEntryId = legacy.secretId
  delete legacy.secretId
}
