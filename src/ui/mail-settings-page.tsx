/**
 * p1.2 / p1.3：设置 · 邮箱工作指令 + 计划模式 / 抽技能提示词。
 */

import { useEffect, useState } from 'react'
import type { AppSettings, MailInstructionSettings, PublicSecret } from '../domain/types.ts'
import { DEFAULT_MAIL_TASK_PROMPT, DEFAULT_PLAN_MODE_PROMPT, DEFAULT_SKILL_EXTRACT_PROMPT } from '../storage/schema.ts'
import { requestJson } from './api.ts'

type Props = {
  secrets: PublicSecret[]
  onBack: () => void
  onOpenVault: () => void
  onOpenTasks: () => void
}

const emptyEndpoint = { host: '', port: 993, tls: true, username: '', vaultEntryId: undefined as string | undefined }

function blankMail(): MailInstructionSettings {
  return {
    enabled: false,
    imap: { ...emptyEndpoint, port: 993 },
    smtp: { ...emptyEndpoint, port: 465 },
    whitelist: [],
    pollIntervalMinutes: 10,
    taskPrompt: DEFAULT_MAIL_TASK_PROMPT,
    autoConfirm: true,
  }
}

export function MailSettingsPage({ secrets, onBack, onOpenVault, onOpenTasks }: Props) {
  const [mail, setMail] = useState<MailInstructionSettings>(blankMail())
  const [planPrompt, setPlanPrompt] = useState(DEFAULT_PLAN_MODE_PROMPT)
  const [baselinePrompt, setBaselinePrompt] = useState(DEFAULT_PLAN_MODE_PROMPT)
  const [skillPrompt, setSkillPrompt] = useState(DEFAULT_SKILL_EXTRACT_PROMPT)
  const [baselineSkillPrompt, setBaselineSkillPrompt] = useState(DEFAULT_SKILL_EXTRACT_PROMPT)
  const [wlInput, setWlInput] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stop = false
    void requestJson<{ ok: true; settings: AppSettings }>('/api/settings')
      .then((payload) => {
        if (stop) return
        setMail(payload.settings.mailInstructions)
        setPlanPrompt(payload.settings.planModePrompt)
        setBaselinePrompt(payload.settings.planModePrompt)
        setSkillPrompt(payload.settings.skillExtractPrompt)
        setBaselineSkillPrompt(payload.settings.skillExtractPrompt)
      })
      .catch((cause) => {
        if (!stop) setError(cause instanceof Error ? cause.message : '加载设置失败')
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [])

  async function save(
    patch: { mailInstructions?: MailInstructionSettings; planModePrompt?: string; skillExtractPrompt?: string },
    okText: string,
  ) {
    setError('')
    setPending(true)
    try {
      const payload = await requestJson<{ ok: true; settings: AppSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
      setMail(payload.settings.mailInstructions)
      setPlanPrompt(payload.settings.planModePrompt)
      setBaselinePrompt(payload.settings.planModePrompt)
      setSkillPrompt(payload.settings.skillExtractPrompt)
      setBaselineSkillPrompt(payload.settings.skillExtractPrompt)
      setNotice(okText)
      setTimeout(() => setNotice(''), 2200)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setPending(false)
    }
  }

  function bumpPoll(delta: number) {
    const next = Math.min(60, Math.max(1, mail.pollIntervalMinutes + delta))
    setMail({ ...mail, pollIntervalMinutes: next })
  }

  function addWhitelist() {
    const value = wlInput.trim().toLowerCase()
    if (!value || !value.includes('@')) {
      setError('请输入有效邮箱')
      return
    }
    if (mail.whitelist.some((item) => item.toLowerCase() === value)) {
      setWlInput('')
      return
    }
    setMail({ ...mail, whitelist: [...mail.whitelist, value] })
    setWlInput('')
    setError('')
  }

  const vaultOptions = secrets.filter((item) => item.kind === 'api-key' || item.kind === 'login')
  const promptDirty = planPrompt.trim() !== baselinePrompt.trim()
  const skillPromptDirty = skillPrompt.trim() !== baselineSkillPrompt.trim()

  if (loading) {
    return (
      <div className="page">
        <header className="page-hd">
          <div className="page-title">邮箱 / 工作指令</div>
        </header>
        <div className="page-bd">
          <p className="hint">加载中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-hd">
        <div>
          <div className="page-title">邮箱 / 工作指令</div>
          <div className="page-sub">应用侧 IMAP 拉信 · SMTP 回结果 · 写入绑定好友会话 · 白名单 · 计划 / 抽技能提示词</div>
        </div>
        <div className="grow" />
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          返回设置
        </button>
        <button type="button" className="btn btn-ghost" onClick={onOpenTasks}>
          看定时任务
        </button>
      </header>

      <div className="page-bd">
        <div className="page-layout-wide mail-settings" style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
          <div className="mail-note" role="note">
            <strong>应用侧拉信</strong>：本机服务用 IMAP <strong>自己拉信</strong>、白名单过滤后，把正文写入
            <strong>绑定好友会话</strong>并触发对话；跑完后 SMTP 回<strong>结果摘要</strong>（不贴逐步 tool 日志）。
            <strong>模型不连邮箱</strong>。启用后默认挂系统任务「每 10 分钟拉取工作指令邮件」（绑定群主，可在自动化任务改）。
            白名单 From <strong>精确匹配、大小写不敏感</strong>。密钥走密码库引用。
            邮件任务默认按<strong>无人值守</strong>处理：写文件 / 跑命令直接执行，不再出确认气泡；仍受工作目录与代码权限限制，可在下方关闭。
            正文点名后改交给对方，例如「帮我看看小程序长租车都返回了什么字段，停车场业务的」或「，彩票走势图群」；没点名仍由绑定好友处理。
          </div>

          <div>
            <div className="inset-section-title">通道</div>
            <div className="inset-group">
              <div className="inset-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>启用邮箱工作指令</div>
                  <div className="help">关闭则不拉信、不回信；群主聊天照常</div>
                </div>
                <button
                  className={mail.enabled ? 'toggle is-on' : 'toggle'}
                  type="button"
                  aria-pressed={mail.enabled}
                  title={mail.enabled ? '启用' : '停用'}
                  onClick={() => setMail({ ...mail, enabled: !mail.enabled })}
                />
              </div>
              <div className="inset-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>轮询间隔</div>
                  <div className="help">群主默认定时拉信；默认 10 分钟</div>
                </div>
                <div className="stepper" role="group" aria-label="轮询间隔（分钟）">
                  <button type="button" className="stepper-btn" aria-label="减少" onClick={() => bumpPoll(-1)}>
                    −
                  </button>
                  <span className="stepper-value">{mail.pollIntervalMinutes} 分钟</span>
                  <button type="button" className="stepper-btn" aria-label="增加" onClick={() => bumpPoll(1)}>
                    +
                  </button>
                </div>
              </div>
              <div className="inset-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>无人值守自动执行</div>
                  <div className="help">
                    邮件任务里的写文件 / shell 直接执行，不再出确认气泡；仍受工作目录与代码权限限制
                  </div>
                </div>
                <button
                  className={mail.autoConfirm !== false ? 'toggle is-on' : 'toggle'}
                  type="button"
                  aria-pressed={mail.autoConfirm !== false}
                  title={mail.autoConfirm !== false ? '已开启' : '已关闭'}
                  onClick={() => setMail({ ...mail, autoConfirm: !(mail.autoConfirm !== false) })}
                />
              </div>
            </div>
          </div>

          <EndpointBlock
            title="IMAP · 收信（拉工作指令）"
            endpoint={mail.imap}
            vaultOptions={vaultOptions}
            onOpenVault={onOpenVault}
            onChange={(imap) => setMail({ ...mail, imap })}
          />
          <EndpointBlock
            title="SMTP · 发信（回结果）"
            endpoint={mail.smtp}
            vaultOptions={vaultOptions}
            onOpenVault={onOpenVault}
            onChange={(smtp) => setMail({ ...mail, smtp })}
          />

          <div>
            <div className="inset-section-title">工作指令发件人白名单</div>
            <div className="inset-group">
              <div className="inset-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                <div className="help" style={{ margin: 0 }}>
                  仅这些 From 才执行（精确匹配 · 大小写不敏感）。例：收件箱三封里只跑 <code>owner@example.com</code>。
                </div>
                <div className="whitelist-chips" aria-label="白名单">
                  {mail.whitelist.length === 0 ? <span className="hint">尚未添加</span> : null}
                  {mail.whitelist.map((addr) => (
                    <span className="wl-chip" key={addr}>
                      {addr}{' '}
                      <button
                        type="button"
                        className="wl-x"
                        aria-label="移除"
                        onClick={() => setMail({ ...mail, whitelist: mail.whitelist.filter((item) => item !== addr) })}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div className="wl-add-row">
                  <input
                    type="email"
                    value={wlInput}
                    placeholder="添加发件人邮箱"
                    aria-label="添加白名单邮箱"
                    onChange={(event) => setWlInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addWhitelist()
                      }
                    }}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addWhitelist}>
                    添加
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="inset-section-title">邮件工作提示词</div>
            <div className="inset-group plan-prompt-block">
              <p className="help" style={{ margin: '0 0 8px', padding: '0 2px' }}>
                只在邮件工作指令回合注入。人不在电脑旁：提示模型直接动手、不要反问或等确认，最后给一段可回信的结果。空白会回默认模板。
              </p>
              <textarea
                className="plan-prompt-ta"
                rows={14}
                spellCheck={false}
                aria-label="邮件工作提示词"
                value={mail.taskPrompt ?? DEFAULT_MAIL_TASK_PROMPT}
                onChange={(event) => setMail({ ...mail, taskPrompt: event.target.value })}
              />
              <div className="plan-prompt-ft">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMail({ ...mail, taskPrompt: DEFAULT_MAIL_TASK_PROMPT })}
                >
                  恢复默认
                </button>
                <span className="hint">
                  {(mail.taskPrompt ?? DEFAULT_MAIL_TASK_PROMPT).trim() === DEFAULT_MAIL_TASK_PROMPT
                    ? '默认模板'
                    : '已改动 · 记得保存'}
                </span>
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => void save({ mailInstructions: mail }, '邮件提示词已保存')}
                >
                  保存提示词
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="inset-section-title">计划模式 · 通用提示词</div>
            <div className="inset-group plan-prompt-block">
              <p className="help" style={{ margin: '0 0 8px', padding: '0 2px' }}>
                全局生效；仅在「计划模式」注入。改后对新开计划回合立即生效。有默认模板，可恢复。
              </p>
              <textarea
                className="plan-prompt-ta"
                rows={16}
                spellCheck={false}
                aria-label="计划模式通用提示词"
                value={planPrompt}
                onChange={(event) => setPlanPrompt(event.target.value)}
              />
              <div className="plan-prompt-ft">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPlanPrompt(DEFAULT_PLAN_MODE_PROMPT)}
                >
                  恢复默认
                </button>
                <span className="hint">{promptDirty ? '已改动 · 记得保存' : '未改动 · 当前已保存'}</span>
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => void save({ planModePrompt: planPrompt }, '计划提示词已保存')}
                >
                  保存提示词
                </button>
              </div>
            </div>
          </div>


          <div>
            <div className="inset-section-title">抽技能 · 系统提示词</div>
            <div className="inset-group plan-prompt-block">
              <p className="help" style={{ margin: '0 0 8px', padding: '0 2px' }}>
                全局 ·「保存为技能」抽会话时注入。≠ 好友自身系统提示词。改后对新抽立即生效；可恢复默认。
              </p>
              <textarea
                className="plan-prompt-ta"
                rows={14}
                spellCheck={false}
                aria-label="抽技能系统提示词"
                value={skillPrompt}
                onChange={(event) => setSkillPrompt(event.target.value)}
              />
              <div className="plan-prompt-ft">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSkillPrompt(DEFAULT_SKILL_EXTRACT_PROMPT)}
                >
                  恢复默认
                </button>
                <span className="hint">{skillPromptDirty ? '已改动 · 记得保存' : '未改动 · 当前已保存'}</span>
                <div className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => void save({ skillExtractPrompt: skillPrompt }, '抽技能提示词已保存')}
                >
                  保存提示词
                </button>
              </div>
            </div>
          </div>

          {error ? <p className="form-error">{error}</p> : null}
          {notice ? (
            <div className="chat-toast is-on" role="status">
              {notice}
            </div>
          ) : null}

          <div className="mail-actions">
            <button type="button" className="btn btn-secondary" onClick={onBack}>
              取消
            </button>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => void save({ mailInstructions: mail, planModePrompt: planPrompt, skillExtractPrompt: skillPrompt }, '邮箱设置已保存')}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EndpointBlock({
  title,
  endpoint,
  vaultOptions,
  onOpenVault,
  onChange,
}: {
  title: string
  endpoint: MailInstructionSettings['imap']
  vaultOptions: PublicSecret[]
  onOpenVault: () => void
  onChange: (next: MailInstructionSettings['imap']) => void
}) {
  return (
    <div>
      <div className="inset-section-title">{title}</div>
      <div className="inset-group mail-fields">
        <div className="inset-row">
          <label className="inset-label">主机</label>
          <input
            type="text"
            value={endpoint.host}
            autoComplete="off"
            onChange={(event) => onChange({ ...endpoint, host: event.target.value })}
          />
        </div>
        <div className="inset-row">
          <label className="inset-label">端口</label>
          <input
            type="number"
            value={endpoint.port}
            style={{ maxWidth: 100 }}
            onChange={(event) => onChange({ ...endpoint, port: Number(event.target.value) || endpoint.port })}
          />
          <label className="mail-tls">
            <input
              type="checkbox"
              checked={endpoint.tls}
              onChange={(event) => onChange({ ...endpoint, tls: event.target.checked })}
            />{' '}
            TLS
          </label>
        </div>
        <div className="inset-row">
          <label className="inset-label">账号</label>
          <input
            type="email"
            value={endpoint.username}
            autoComplete="username"
            onChange={(event) => onChange({ ...endpoint, username: event.target.value })}
          />
        </div>
        <div className="inset-row">
          <label className="inset-label">密码 / 密钥</label>
          <div className="vault-ref">
            <select
              value={endpoint.vaultEntryId ?? ''}
              aria-label="密码库引用"
              onChange={(event) =>
                onChange({
                  ...endpoint,
                  vaultEntryId: event.target.value || undefined,
                })
              }
            >
              <option value="">未选择（密码库引用）</option>
              {vaultOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenVault}>
              从密码库选
            </button>
          </div>
        </div>
        <div className="mail-field-help">密钥走密码库引用，此处不存明文（对齐 Provider）。</div>
      </div>
    </div>
  )
}
