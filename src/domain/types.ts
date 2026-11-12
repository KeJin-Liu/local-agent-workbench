/**
 * 落在本地库里的记录形状。服务端和页面对这些类型的理解要一致。
 * 头像挂在好友上，避免以后再改表。
 */

export type ProviderKind = 'openai-compatible'

/** none：本地无密钥。optional：有没有都行。required：没有密钥就不能启用。 */
export type ApiKeyPolicy = 'none' | 'optional' | 'required'

export type Provider = {
  id: string
  name: string
  kind: ProviderKind
  /** OpenAI 兼容根地址，含 /v1，无末尾斜杠。 */
  baseUrl: string
  apiKeyPolicy: ApiKeyPolicy
  /** 停用后不能拿来发送。云端预设在填入密钥前保持停用。 */
  enabled: boolean
  /**
   * 保险库条目 id。提供方不再保存明文 apiKey。
   * 粘贴新密钥时先写入保险库，这里只留引用。
   */
  vaultEntryId?: string
  defaultModel?: string
  /** 最近一次探测到的模型 id，供聊天菜单点选。 */
  probedModels?: string[]
  createdAt: number
  updatedAt: number
}

/** 给页面的提供方。没有明文密钥，只说明有没有关联保险库。 */
export type PublicProvider = Provider & {
  hasApiKey: boolean
}

export type CodePermission = 'read-only' | 'workspace-write' | 'danger-full-access'

export type AvatarKind = 'default' | 'upload'

/** 默认头像用 id 指向内置图；上传头像的 path 由服务端签发。 */
export type FriendAvatar = {
  kind: AvatarKind
  id?: string
  path?: string
}

export type ChatMode = 'normal' | 'plan'
export type ReasoningLevel = 'low' | 'medium' | 'high'

/** 视觉插件：会话里有图片时，用这个提供方/模型读图；不填沿用好友默认。 */
export type FriendVision = {
  enabled: boolean
  providerId?: string
  modelId?: string
}

/** 一个智能体就是一个好友。群主模板用 isOwnerTemplate 标出。 */
export type Friend = {
  id: string
  name: string
  description: string
  systemPrompt: string
  isOwnerTemplate: boolean
  avatar: FriendAvatar
  /** 这个好友默认走哪个提供方。 */
  providerId: string
  /**
   * 顶栏选中后持久化的默认模型 id（p0.8.1）。
   * 同好友下次打开 / 新会话沿用；可再改。
   */
  defaultModelId?: string
  /**
   * p1.1：本机 Workspace 绝对路径。未设置则编码三类工具全禁。
   */
  workspacePath?: string
  /**
   * 编码权限。缺省按 workspace-write。
   * danger-full-access 仍限制在 Workspace 内，但写、删、shell 直接执行，不再确认。
   */
  codePermission?: CodePermission
  /**
   * p1.2：新会话默认对话模式（普通 / 计划）。
   */
  defaultChatMode?: ChatMode
  /**
   * p1.2：新会话默认推理程度。
   */
  defaultReasoningLevel?: ReasoningLevel
  /** 视觉插件；旧好友没有这个字段 = 未开启。 */
  vision?: FriendVision
  createdAt: number
  updatedAt: number
}

export type ConversationKind = 'direct' | 'group'

/** 群内覆盖的成员模型。只挂在会话上，不改好友的默认模型。 */
export type GroupMemberModel = {
  providerId: string
  model: string
}

export type Conversation = {
  id: string
  title: string
  kind: ConversationKind
  /** 单聊一个好友；群聊挂多个好友 id。 */
  friendIds: string[]
  /** 群头像；没有则用默认「群」字块。单聊沿用好友头像，不写这里。 */
  avatar?: FriendAvatar
  providerId: string
  model?: string
  /**
   * 同一联系人的多段对话共用这个键。列表只显示最新一段。
   * 单聊一般是 `friend:<好友 id>`，群聊沿用第一段的 id。
   */
  lineageId?: string
  /**
   * p1.2：当前会话对话模式。缺省 normal。
   */
  chatMode?: ChatMode
  /**
   * p1.2：推理程度。缺省 medium；无模型参数时只影响提示。
   */
  reasoningLevel?: ReasoningLevel
  /**
   * p1.2：进行中的计划记录 id。
   */
  activePlanId?: string
  /**
   * 群工作空间根目录。成员默认落在「根目录/群名称/好友名」。
   * 不写进好友资料，单聊仍用好友自己的 workspacePath。
   */
  workspaceRoot?: string
  /** 群内手动指定的成员目录，friendId → 绝对路径。没有的成员走自动子目录。 */
  memberWorkspaces?: Record<string, string>
  /**
   * 只在本群注入的成员提示词，friendId → 正文。
   * 没有这条时，本群不使用好友资料里的 systemPrompt。
   */
  memberPrompts?: Record<string, string>
  /**
   * 只在本群生效的成员模型，friendId → 提供方和模型。
   * 没有这条时用好友自己的 providerId / defaultModelId，不写回好友资料。
   */
  memberModels?: Record<string, GroupMemberModel>
  /**
   * 群已归档。缺省或 false 表示仍在「全部 / 群组」里。
   * 同一群的每一段对话共用这个标记，列表只在「归档」页签显示。
   */
  archived?: boolean
  createdAt: number
  updatedAt: number
}

/** 列表用的会话。preview 由接口现算，不写入本地库。 */
export type ConversationCard = Conversation & {
  preview: string
}

export type MessageRole = 'system' | 'user' | 'assistant'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error'

export type MessageKind = 'text' | 'assign' | 'result'

/** 聊天附件。先上传拿回描述，再随 send 挂到消息上。 */
export type MessageAttachment = {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** 静态地址，如 /media/files/<id>.png */
  path: string
}

/** p0.9：本回合实际注入了哪些记忆层（挂在助手消息上，供来源条回放）。 */
export type MemoryInject = {
  workingCount: number
  summary: boolean
  summaryId?: string
  ltmFriendCount: number
  ltmProjectCount: number
  /** 注入的长期记忆 id，预览用 */
  ltmIds?: string[]
}

export type Message = {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  speakerFriendId?: string
  status: MessageStatus
  runId?: string
  error?: string
  /** 普通气泡不写。指派卡和回流卡用 assign / result。 */
  kind?: MessageKind
  assignmentId?: string
  /** 用户消息可选图片/文件；无附件时不写，纯文字路径不变。 */
  attachments?: MessageAttachment[]
  /**
   * 模型思维链 / reasoning。仅助手消息；无产出时不写。
   * 与 content 分流，供可折叠展示。
   */
  reasoning?: string
  /** p0.9：生成此条助手回复时注入的记忆来源。 */
  memoryInject?: MemoryInject
  createdAt: number
}

export type RunStatus = 'pending' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type Run = {
  id: string
  conversationId: string
  /** 这条 run 对应的用户消息。取消时连同它一起从会话里拿掉。 */
  messageId?: string
  status: RunStatus
  idempotencyKey: string
  providerId: string
  model: string
  /** 这一回合实际接话的好友；群聊 @ 点名时可能不是会话首位。 */
  speakerFriendId?: string
  /** 本回合是否走了视觉插件（有图片 + 模型支持）。 */
  vision?: boolean
  error?: string
  /** 取消时交还给输入框的原文。 */
  draftText?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export type SummarySource = 'auto' | 'manual'

export type Summary = {
  id: string
  conversationId: string
  content: string
  coversUntilMessageId?: string
  /** 为真时，后续模型回合会把这段摘要放进系统上下文。 */
  injectOnNextTurn?: boolean
  source?: SummarySource
  createdAt: number
  updatedAt: number
}

export type SkillStatus = 'draft' | 'ready'

export type SettingScope = 'global' | 'friends'

/** MCP 还可以挂到指定群。技能和任务仍只用 SettingScope。 */
export type McpScope = SettingScope | 'groups'

export type Skill = {
  id: string
  name: string
  description: string
  body: string
  status: SkillStatus
  /** 确认卡落库后的可见范围。缺省视为全局。手工保存时用 friends。 */
  scope?: SettingScope
  friendIds?: string[]
  /** 手工保存时从对话拆出的步骤。正文 body 仍保留可读文本。 */
  steps?: string[]
  createdAt: number
  updatedAt: number
}

export type TaskSchedule = 'manual' | 'cron'
export type TaskLastStatus = 'none' | 'running' | 'success' | 'error' | 'cancelled'
/** prompt=普通好友提示词任务；system_mail_poll=应用侧 IMAP 拉信（不进 LLM prompt）。 */
export type TaskKind = 'prompt' | 'system_mail_poll'

export type TaskHistoryEntry = {
  id: string
  status: 'running' | 'success' | 'error' | 'cancelled'
  result?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

/** 绑定一个好友执行。未确认的提案不会写成这种记录。 */
export type AutomationTask = {
  id: string
  name: string
  friendId: string
  prompt: string
  /** 缺省按 prompt；拉信系统任务为 system_mail_poll。 */
  kind?: TaskKind
  schedule: TaskSchedule
  cron?: string
  targetConversationId?: string
  scope: SettingScope
  friendIds?: string[]
  enabled: boolean
  lastStatus: TaskLastStatus
  lastError?: string
  lastRunAt?: number
  history: TaskHistoryEntry[]
  createdAt: number
  updatedAt: number
}

export type ProposalKind =
  | 'skill'
  | 'mcp'
  | 'task'
  | 'friend'
  | 'provider'
  | 'app_settings'
  | 'friend_patch'
  | 'group'
  | 'vault_binding'
export type ProposalStatus = 'pending' | 'confirmed' | 'cancelled'

/** 模型提案。确认前只存在这里，技能 / MCP / 任务本体尚未写入。 */
export type Proposal = {
  id: string
  conversationId: string
  kind: ProposalKind
  name: string
  summary: string
  draft: Record<string, unknown>
  status: ProposalStatus
  error?: string
  scope?: SettingScope | 'groups'
  friendIds?: string[]
  /** MCP 确认为指定群时记下群 lineage。同一群的每一段对话共用。 */
  groupIds?: string[]
  createdAt: number
  updatedAt: number
}

export type CodeActionKind = 'write' | 'shell' | 'delete'
export type CodeActionStatus = 'pending' | 'confirmed' | 'cancelled' | 'failed'

/** p1.1：写文件 / shell 门闩。确认前磁盘与进程不变。 */
export type CodeAction = {
  id: string
  conversationId: string
  friendId: string
  runId?: string
  kind: CodeActionKind
  summary: string
  status: CodeActionStatus
  draft: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  createdAt: number
  updatedAt: number
}

export type CodeToolTimelineOutcome = 'ok' | 'denied' | 'pending' | 'confirmed' | 'cancelled' | 'error'

/** p1.1：会话内工具时间线条目，供可折叠回看。 */
export type CodeToolTimelineEntry = {
  id: string
  conversationId: string
  runId?: string
  friendId: string
  toolName: string
  detail: string
  outcome: CodeToolTimelineOutcome
  resultSummary?: string
  createdAt: number
}

export type AssignmentStatus = 'pending' | 'done' | 'cancelled'

export type Assignment = {
  id: string
  conversationId: string
  fromFriendId: string
  toFriendId: string
  instruction: string
  status: AssignmentStatus
  /** 回流到本群的那条结果消息。 */
  resultMessageId?: string
  error?: string
  /** 执行中的进度人话（调用哪个工具 / 第几步），完成后清掉。 */
  progress?: string
  /** 这次执行实际调用的工具步数。 */
  steps?: number
  createdAt: number
  updatedAt: number
}

export type SecretKind = 'api-key' | 'login'

/** 落库的保险库条目。口令和 API Key 只以密文保存。 */
export type VaultSecretRecord = {
  id: string
  name: string
  kind: SecretKind
  /** 登录名可以显示在列表里，便于辨认条目。 */
  username?: string
  ciphertext: string
  createdAt: number
  updatedAt: number
}

export type PublicSecret = {
  id: string
  name: string
  kind: SecretKind
  username?: string
  updatedAt: number
}

export type McpTransport = 'stdio' | 'sse' | 'http'

export type McpEnvBinding = {
  name: string
  /** 优先引用保险库。明文 value 只适合非秘密配置。 */
  vaultEntryId?: string
  value?: string
}

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpServer = {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env: McpEnvBinding[]
  /** sse / http 的请求头。值可以是明文，或引用保险库。 */
  headers: McpEnvBinding[]
  scope?: McpScope
  friendIds?: string[]
  /** scope 为 groups 时，这些群 lineage 可用。同一群另起一段仍然算同一个群。 */
  groupIds?: string[]
  /** 来自本地市场目录时记下 catalog id，便于 Resources 与启用态。 */
  catalogId?: string
  createdAt: number
  updatedAt: number
}

export type McpConnectionView = {
  status: McpConnectionStatus
  error?: string
  tools: McpToolPreview[]
}

/** 配置加上当前进程里的连接状态。状态不写入磁盘。 */
export type McpServerView = McpServer & {
  connection: McpConnectionView
}

export type McpToolPreview = {
  name: string
  description?: string
}

/** 本地 MCP 市场目录项（非云商店）。enabled 由已配置服务推导。 */
export type McpCatalogEntry = {
  id: string
  name: string
  summary: string
  transport: McpTransport
  toolCount: number
  icon: string
  enabled: boolean
  serverId?: string
}

export type McpResource = {
  uri: string
  name: string
  mime?: string
  description?: string
  textPreview?: string
}

export type McpPrompt = {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
  template?: string
}


export type LongTermMemoryScope = 'friend' | 'project'

export type LongTermMemorySource = 'auto' | 'manual'

/** 挂在好友或项目/群上的跨会话事实。与会话摘要分开。 */
export type LongTermMemory = {
  id: string
  scope: LongTermMemoryScope
  /** 好友 id，或群会话 lineageId / 会话 id。 */
  ownerId: string
  fact: string
  source: LongTermMemorySource
  /** 是否注入后续模型回合。 */
  injectEnabled: boolean
  pinned?: boolean
  createdAt: number
  /** epoch ms；界面按 Asia/Shanghai 展示。 */
  updatedAt: number
}

/** 作用域级注入总开关。缺省视为开启。 */
export type LtmInjectPref = {
  id: string
  scope: LongTermMemoryScope
  ownerId: string
  injectEnabled: boolean
  updatedAt: number
}

export type SkillSuggestionStatus = 'pending' | 'accepted' | 'dismissed'

/** 系统检测到的重复模式建议。pending/dismissed 都不会写成正式技能。 */
export type SkillSuggestion = {
  id: string
  conversationId: string
  /** 建议默认挂到的好友。 */
  friendId: string
  pattern: string
  occurrenceCount: number
  name: string
  steps: string[]
  scope?: SettingScope
  friendIds?: string[]
  status: SkillSuggestionStatus
  /** 规范化后的指纹，用于去重与静默。 */
  fingerprint: string
  createdAt: number
  updatedAt: number
}

/** 「以后不再建议类似模式」的静默记录。不是技能。 */
export type SkillSuggestionMute = {
  id: string
  friendId: string
  fingerprint: string
  createdAt: number
}


/** 计划模式澄清卡。点选前不写进助手正文。 */
export type ClarifyStatus = 'open' | 'answered'

export type ClarifyCard = {
  id: string
  conversationId: string
  runId?: string
  question: string
  options: string[]
  status: ClarifyStatus
  /** 用户点中的选项原文。 */
  picked?: string
  createdAt: number
  updatedAt: number
}

/** p1.2：计划模式状态。确认前不允许副作用步骤。 */
export type PlanStatus = 'awaiting_confirm' | 'executing' | 'done' | 'cancelled' | 'failed'

export type PlanStep = {
  index: number
  title: string
  done: boolean
  result?: string
}

export type PlanRecord = {
  id: string
  conversationId: string
  friendId?: string
  title: string
  filePath: string
  status: PlanStatus
  steps: PlanStep[]
  createdAt: number
  updatedAt: number
}

/** p1.2：邮箱端点；密钥只引用密码库。 */
export type MailEndpointConfig = {
  host: string
  port: number
  tls: boolean
  username: string
  vaultEntryId?: string
}

export type MailInstructionSettings = {
  enabled: boolean
  imap: MailEndpointConfig
  smtp: MailEndpointConfig
  /** 精确匹配 From；比较时大小写不敏感。 */
  whitelist: string[]
  /** 轮询间隔分钟；默认 10。 */
  pollIntervalMinutes: number
  /** 无人值守邮件任务的系统提示词；空白回默认模板。 */
  taskPrompt?: string
  /** 邮件任务里的写文件 / shell 是否直接执行（不再出确认气泡）。默认 true。 */
  autoConfirm?: boolean
}

export type ProcessedMailStatus = 'executed' | 'skipped' | 'failed'

/** p1.2：已处理邮件，用于去重。 */
export type ProcessedMailRecord = {
  id: string
  from: string
  subject: string
  status: ProcessedMailStatus
  reason?: string
  resultSummary?: string
  processedAt: number
}

export type SkillExtractDraftStatus = 'pending' | 'confirmed' | 'cancelled'

/** p1.3：会话抽技能待确认草案。pending 不写 skills。 */
export type SkillExtractDraft = {
  id: string
  /** 草案气泡所在会话（当前打开的好友会话）。 */
  conversationId: string
  friendId: string
  sourceConversationIds: string[]
  messageId: string
  name: string
  steps: string[]
  body: string
  scenario?: string
  status: SkillExtractDraftStatus
  skillId?: string
  createdAt: number
  updatedAt: number
}

export type WorkbenchStores = {
  providers: Provider[]
  friends: Friend[]
  conversations: Conversation[]
  messages: Message[]
  runs: Run[]
  summaries: Summary[]
  skills: Skill[]
  assignments: Assignment[]
  secrets: VaultSecretRecord[]
  mcpServers: McpServer[]
  tasks: AutomationTask[]
  proposals: Proposal[]
  codeActions: CodeAction[]
  codeToolEvents: CodeToolTimelineEntry[]
  longTermMemories: LongTermMemory[]
  ltmInjectPrefs: LtmInjectPref[]
  skillSuggestions: SkillSuggestion[]
  skillSuggestionMutes: SkillSuggestionMute[]
  planRecords: PlanRecord[]
  clarifies: ClarifyCard[]
  processedMails: ProcessedMailRecord[]
  skillExtractDrafts: SkillExtractDraft[]
}

export type AppSettings = {
  /** 发送后等待再调模型的秒数，整数 1–10；默认 5。 */
  sendWaitSeconds: number
  /** p1.2：邮箱工作指令通道。 */
  mailInstructions: MailInstructionSettings
  /**
   * p1.2：计划模式通用系统提示词（设置里可编辑；全局生效）。
   * 可用 {{planPath}} 占位实际计划文件路径。
   */
  planModePrompt: string
  /**
   * p1.3：抽技能系统提示词（设置可编辑·恢复默认；全局）。
   * 与 Friend.systemPrompt 无关。
   */
  skillExtractPrompt: string
}

export type WorkbenchDocument = {
  name: string
  version: number
  stores: WorkbenchStores
  /** 全局偏好；旧库缺字段时打开时补默认。 */
  settings?: AppSettings
}

/** 冷启动和缺头像记录共用这一枚，避免各处写不同的默认值。 */
export const DEFAULT_FRIEND_AVATAR: FriendAvatar = {
  kind: 'default',
  id: 'seal',
  path: '/avatars/defaults/seal.svg',
}
