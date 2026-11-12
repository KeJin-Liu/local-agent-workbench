/**
 * 全局应用设置。落在 agent_workbench.json 的 settings 字段。
 */

import type { AppSettings, MailInstructionSettings } from '../domain/types.ts'
import type { WorkbenchDatabase } from '../storage/database.ts'
import {
  clampSendWaitSeconds,
  normalizeAppSettings,
  normalizeMailSettings,
  normalizePlanModePrompt,
  normalizeSkillExtractPrompt,
} from '../storage/schema.ts'

export {
  clampSendWaitSeconds,
  normalizeAppSettings,
  normalizeMailSettings,
  normalizePlanModePrompt,
  normalizeSkillExtractPrompt,
  resolvePlanModeSystemPrompt,
  DEFAULT_SEND_WAIT_SECONDS,
  DEFAULT_PLAN_MODE_PROMPT,
  DEFAULT_SKILL_EXTRACT_PROMPT,
  DEFAULT_MAIL_POLL_MINUTES,
  DEFAULT_MAIL_TASK_PROMPT,
  normalizeMailTaskPrompt,
  defaultMailInstructions,
} from '../storage/schema.ts'

export type AppSettingsPatch = {
  sendWaitSeconds?: number
  mailInstructions?: Partial<MailInstructionSettings> | MailInstructionSettings
  planModePrompt?: string
  skillExtractPrompt?: string
}

export async function getAppSettings(database: WorkbenchDatabase): Promise<AppSettings> {
  const document = await database.read()
  return normalizeAppSettings(document.settings)
}

export async function updateAppSettings(
  database: WorkbenchDatabase,
  patch: AppSettingsPatch,
): Promise<AppSettings> {
  return database.update((draft) => {
    const current = normalizeAppSettings(draft.settings)
    const next = normalizeAppSettings({
      sendWaitSeconds:
        patch.sendWaitSeconds !== undefined
          ? clampSendWaitSeconds(patch.sendWaitSeconds)
          : current.sendWaitSeconds,
      mailInstructions:
        patch.mailInstructions !== undefined
          ? normalizeMailSettings({
              ...current.mailInstructions,
              ...patch.mailInstructions,
              imap: patch.mailInstructions.imap
                ? { ...current.mailInstructions.imap, ...patch.mailInstructions.imap }
                : current.mailInstructions.imap,
              smtp: patch.mailInstructions.smtp
                ? { ...current.mailInstructions.smtp, ...patch.mailInstructions.smtp }
                : current.mailInstructions.smtp,
              whitelist:
                patch.mailInstructions.whitelist !== undefined
                  ? patch.mailInstructions.whitelist
                  : current.mailInstructions.whitelist,
            })
          : current.mailInstructions,
      planModePrompt:
        patch.planModePrompt !== undefined
          ? normalizePlanModePrompt(patch.planModePrompt)
          : current.planModePrompt,
      skillExtractPrompt:
        patch.skillExtractPrompt !== undefined
          ? normalizeSkillExtractPrompt(patch.skillExtractPrompt)
          : current.skillExtractPrompt,
    })
    draft.settings = next
    return next
  })
}
