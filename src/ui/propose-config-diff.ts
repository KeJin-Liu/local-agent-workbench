/** p1.4 app_settings ConfirmCard diff 行（纯逻辑，供 UI 与测试共用）。 */

export type AppDiffItem = {
  key: string
  next: string
  unchanged?: boolean
}

export function buildAppSettingsDiff(draft: Record<string, unknown>): AppDiffItem[] {
  const items: AppDiffItem[] = []
  const touched = new Set<string>()
  if (draft.sendWaitSeconds !== undefined) {
    items.push({ key: 'sendWaitSeconds', next: String(draft.sendWaitSeconds) })
    touched.add('sendWaitSeconds')
  }
  if (draft.planModePrompt !== undefined) {
    const text = String(draft.planModePrompt).trim()
    items.push({ key: 'planModePrompt', next: text.slice(0, 48) + (text.length > 48 ? '…' : '') })
    touched.add('planModePrompt')
  }
  if (draft.skillExtractPrompt !== undefined) {
    const text = String(draft.skillExtractPrompt).trim()
    items.push({ key: 'skillExtractPrompt', next: text.slice(0, 48) + (text.length > 48 ? '…' : '') })
    touched.add('skillExtractPrompt')
  }
  if (draft.mailInstructions !== undefined && draft.mailInstructions && typeof draft.mailInstructions === 'object') {
    const mail = draft.mailInstructions as Record<string, unknown>
    if (mail.enabled !== undefined) {
      items.push({ key: 'mailInstructions.enabled', next: mail.enabled ? '开' : '关' })
    }
    if (Array.isArray(mail.whitelist)) {
      items.push({ key: 'mailInstructions.whitelist', next: `${mail.whitelist.length} 项` })
    }
    if (mail.pollIntervalMinutes !== undefined) {
      items.push({ key: 'mailInstructions.pollIntervalMinutes', next: `${mail.pollIntervalMinutes}` })
    }
    if (mail.imap || mail.smtp) {
      items.push({ key: 'mailInstructions.endpoints', next: '有改动' })
    }
    touched.add('mailInstructions')
  }
  for (const key of ['sendWaitSeconds', 'planModePrompt', 'skillExtractPrompt', 'mailInstructions'] as const) {
    if (!touched.has(key)) items.push({ key, next: '', unchanged: true })
  }
  return items
}
