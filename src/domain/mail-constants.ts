/**
 * 邮箱拉信任务的共享常量。
 *
 * 前端（任务页）和后端（app/mail-instructions）都要用这几个值，所以放在 domain 下：
 * 这里不能 import imapflow / nodemailer / node:*，否则浏览器构建会把服务端依赖拖进页面。
 */

export const MAIL_POLL_TASK_ID = 'task-mail-work-instructions'
export const MAIL_POLL_TASK_NAME = '拉取工作指令邮件'
export const MAIL_POLL_TASK_KIND = 'system_mail_poll' as const

/** 任务编辑页说明（只读/弱编辑）；真正规则在设置：白名单/IMAP/SMTP。 */
export const MAIL_SYSTEM_DESCRIPTION =
  '系统拉信任务：应用用 IMAP 拉取白名单邮件，把正文作为工作指令写入绑定好友会话并触发对话；完成后 SMTP 回结果摘要。规则在「设置 → 邮箱」，此处说明只读，不要当成让模型找邮箱工具的提示词。'
