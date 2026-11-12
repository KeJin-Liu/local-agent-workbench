/**
 * p1.3.2：探测成功后对表单状态的纯更新。
 * 只改已探测模型列表（及空默认时落到首个），密钥/保险库/Base URL 等原样保留。
 */

export type ProbeFormFields = {
  apiKey: string
  clearApiKey: boolean
  vaultEntryId: string
  baseUrl: string
  name: string
  enabled: boolean
  defaultModel: string
  probedModels: string[]
}

export function applyProbeModelsToFormState<T extends ProbeFormFields>(state: T, modelIds: string[]): T {
  const ids = modelIds.filter(Boolean)
  return {
    ...state,
    probedModels: ids,
    defaultModel:
      state.defaultModel && ids.includes(state.defaultModel)
        ? state.defaultModel
        : state.defaultModel || ids[0] || '',
  }
}
