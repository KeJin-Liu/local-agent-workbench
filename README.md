# 本地智能体工作台 · p1.4.1

浏览器里的本地聊天工作台。信息架构仍是 QQ 式三栏：左侧 SVG 图标栏常驻（会话、MCP、密码库、自动化任务、设置，**没有好友图标**），中间是**通讯录**而不是会话流水。页签「全部」列出全部好友和群，「好友」「群组」只做过滤。点一行直接打开聊天；还没有对话时会按联系人建好再打开，列表仍然一行。同一好友或群要另起一段，在输入框发送 `/new_chat`（`POST /api/conversations/:id/new-chat`）或点输入栏右侧「新会话」；旧消息留在原来的记录里，通讯录不新增一行，右侧「会话列表」可以在这些段落之间切回。没有独立的「新建会话」入口。右上角「＋」只用来新建好友或发起群聊。好友资料从聊天顶栏齿轮进入；群聊的齿轮打开群设置。设置页里也留着好友管理入口。视觉按 Apple HIG：系统蓝 `#007AFF`、我方气泡蓝底白字、对方灰底 `#E9E9EB`、深炭毛玻璃侧栏。一个 Node 进程同时提供页面和接口，数据写在这台电脑的 `data/` 目录里，不登录、不上传到云端。

这一阶段接通：本地库 `agent_workbench` v1、Ollama / LM Studio / OpenAI / DeepSeek 预设、「群主」好友、OpenAI 兼容的模型探测与对话、会话列表（全部 / 好友 / 群组）、好友（含头像）、自动化任务、会话内确认卡、提供方设置、加密保险库、MCP 工具（官方 SDK，仅 tools），以及带 5 秒取消窗口的发送。智能体就是好友。**p0.4** 加上好友/项目长期记忆与建议技能；**p0.4.1** 修主聊体验、模型点选、失败提示与群主默认打开。**p0.4** 曾加上好友/项目长期记忆（蓝色注入提示，与绿色会话摘要区分），以及重复模式「建议保存为技能」（确认才落库）。
**p1.3.1**：邮箱工作指令改为应用侧 IMAP 拉信 → 白名单 → 写入绑定好友会话并触发编排 → SMTP 回结果摘要；`task-mail-work-instructions` 为 `kind=system_mail_poll`，runner 短路，**不**再把拉信当好友 prompt。
**p1.3.2**：提供方编辑页「探测模型」只刷新已探测列表，**不清**本轮已填 API Key / 保险库引用 / Base URL；探测成功不再 `onSaved` remount 表单。
**p1.4.1**：`defaultFetchInbox` / `defaultSendSmtp` 换成真 IMAP（imapflow）+ SMTP（nodemailer）；密码走保险库；连失败人话进任务历史，禁止静默「拉取 0」。开发可用 `WORKBENCH_MAIL_DRY_RUN=1` 只打日志不真发。UI 正典 `docs/p141-ui/mail-work-inbox.html`（测试连接人话态）。

**p1.4**：扩展 `workbench_propose` 覆盖 provider / app_settings / friend_patch / group / vault_binding；ConfirmCard 确认门闩；Key 脱敏进保险库；`workbench_get_config` 只读摘要。UI 定稿已合 `docs/p14-ui/propose.html` + shots。session_prefs 后置。



## 运行

需要 Node.js 22 或更新版本，包管理用 pnpm。

```bash
pnpm install
pnpm dev
```

打开 [http://127.0.0.1:43123](http://127.0.0.1:43123)。默认只监听 `127.0.0.1`。要给同一台电脑以外的浏览器用，启动前设置 `HOST=0.0.0.0`。

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

`pnpm start` 在生产模式下提供 `dist/`。开发时 Vite 挂在同一个 Node 进程里，不另开前端端口。

本地库文件是 `data/agent_workbench.json`。上传的头像在 `data/avatars/`。聊天附件在 `data/media/`。保险库主密钥是 `data/vault.key`。删掉 `data/` 再启动，会重新种入提供方预设和群主。

公开仓库时不要提交 `data/`、`.env`、`.audit/`（本机 Playwright 浏览器）或 `node_modules/`。`data/` 里有会话、邮箱账号、工作目录路径和保险库密文；`vault.key` 能解开这些密文。两者都已被 `.gitignore` 排除，不要用 `git add -f` 强行加进去。

本仓库以 [MIT](LICENSE) 许可发布。`package.json` 仍标着 `"private": true`，避免被误发到 npm；这不影响把代码放到 GitHub。

## 接通 Ollama

1. 安装并启动 [Ollama](https://ollama.com)。
2. 拉一个模型，例如 `ollama pull qwen2.5:7b`。
3. 确认 OpenAI 兼容根地址是 `http://127.0.0.1:11434/v1`。页面上的「探测模型」由 Node 请求 `{baseUrl}/models`。

这个工作台的页面和接口在同一个源上，探测不经过浏览器，所以 **不依赖** `OLLAMA_ORIGINS` 也能列出模型。

`OLLAMA_ORIGINS` 只在「网页自己直接请求 Ollama」时才需要。Ollama 默认会拦住浏览器跨域。若你用别的页面直连它，要在启动前设置这个环境变量，然后重启服务。

终端里前台启动（macOS / Linux）：

```bash
OLLAMA_ORIGINS=http://127.0.0.1:43123 ollama serve
```

本机随便试、不想逐个写来源时：

```bash
OLLAMA_ORIGINS='*' ollama serve
```

多个来源用英文逗号分开，例如 `http://127.0.0.1:43123,http://localhost:43123`。

macOS 菜单栏里的 Ollama 读不到当前终端的环境变量，要写进启动环境后再完全退出并重新打开：

```bash
launchctl setenv OLLAMA_ORIGINS "http://127.0.0.1:43123"
```

Linux 上如果 Ollama 是 systemd 服务，把 `OLLAMA_ORIGINS` 放进服务环境（例如 `systemctl edit ollama` 里的 `Environment=`），然后重启服务。

接口返回 404 时，先检查 Base URL 是否以 `/v1` 结尾，而不是已经写成 `/v1/models`。

## OpenAI 和 DeepSeek

这两个预设一开始是停用的，因为必须有 API Key。

1. 在 [OpenAI](https://platform.openai.com/api-keys) 或 [DeepSeek](https://platform.deepseek.com/) 创建密钥。
2. 打开「设置 → 保险库」，新建一条 API Key。也可以在「模型」里把密钥粘贴进对应提供方，保存时会立刻写入保险库。
3. 编辑 OpenAI 或 DeepSeek：选中保险库条目，或粘贴一次新密钥，然后勾选「启用」并保存。提供方记录只留下 `vaultEntryId`，不写明文。
4. 编辑好友，把提供方改成 OpenAI 或 DeepSeek，模型填 `gpt-4o-mini` 或 `deepseek-chat`。

密钥只以密文放在保险库。`agent_workbench.json` 的提供方上看不到 `apiKey` 明文。旧文件里如果还有明文，下次启动会迁进保险库并改成引用。列表默认隐藏；点「显示」后明文大约停留 8 秒，点到输入框外面也会收起。点「复制」会放到剪贴板，不必一直摊在页面上。`POST /api/vault/:id/reveal` 才返回明文。日志仍会把 `apiKey`、`password` 和形如 `sk-` 的字符串打成 `[redacted]`。

## 改用 LM Studio

LM Studio 走同一套 OpenAI 兼容客户端。

1. 在 LM Studio 的 Developer / Local Server 里启动服务，并打开 CORS（只有别的网页直连它时才重要；本工作台由 Node 代发，一般不用）。
2. 默认地址一般是 `http://127.0.0.1:1234/v1`。
3. 在工作台右侧「模型」里改 Base URL，保存，再点「探测模型」。

API Key 只在对方要求时才填。填过之后只存在保险库里，提供方配置保存 `vaultEntryId`。

## 发送和取消

点发送后，你的消息会立刻出现在会话里，同时写下一条 `status: "pending"` 的 run。设置页「发送后等待窗口」可配 **1–10 秒**（整数，**默认 5**，与旧行为兼容），全局持久化在 `agent_workbench.json` 的 `settings.sendWaitSeconds`。会话提示与气泡文案跟当前秒数走。这段等待，以及后面的流式生成，都可以按「取消」。

取消会：

- 中止这一次请求的 `AbortSignal`
- 从会话里删掉刚才那条用户消息（生成到一半的回复也不会留下）
- 把原文放回输入框（接口字段 `draftText`）
- 把 run 标成 `cancelled`

取消的回合不会写入摘要或记忆。只有 `status: "done"` 的回合才会把最近发言收成摘要，并默认注入后续回合。

优先级：单次/宿主 `sendDelayMs` → 环境变量 `SEND_DELAY_MS` → 全局设置秒数×1000 → 默认 5000。

```bash
SEND_DELAY_MS=0 pnpm dev
```

接口：`GET/PUT /api/settings`（`{ sendWaitSeconds }`）；`POST /api/conversations/:id/send`，正文 `{ text, model? }`；`POST /api/runs/:id/cancel`。

## 会话摘要注入

一轮正常结束后，工作台把最近的用户和好友发言收成要点，写入 `summaries`，并带上 `injectOnNextTurn: true`。下一轮发给模型时，这段摘要会作为系统消息放在好友人设后面。摘要从本机对话收成，不额外再打一次模型。

聊天顶栏在已注入时显示绿色「摘要已注入」。点「查看摘要」打开面板：可以「手动生成摘要」，再点「保留并注入」。手动生成先不注入，避免还没看过的草稿进入下一轮。

- `GET /api/conversations/:id/summary`
- `POST /api/conversations/:id/summary` 手动生成
- `POST /api/conversations/:id/summary/inject` 保留并注入
- `GET /api/conversations/:id/thread` 同时带回 `summary` 和 `assignments`

## 群聊 @ 好友

群聊输入框里输入 `@`（或全角 `＠`）会列出群成员，点选后插入 `@名字 `。**@ 了某位好友**：这一回合直接由 TA 用自己的提供方和默认模型回复，群主不介入，`Run.speakerFriendId` 记下实际接话人。**不 @**：默认由群主接。

群主的系统提示会带上群成员名单（名字、简介、是否绑定工作目录）。群里只有群主持有本群对话、会话摘要和长期记忆：由群主把目标收成方案，再判断交给哪位成员。其他成员没有这些记忆；用户直接 @ 他们，或群主用 `@好友名` 交办时，对方只看到当前这条任务。群主交办的指令必须自包含。交办会自动创建一条「群主指派」，被点名好友按开发回流执行，结果仍以卡片回流本群。用户直接 @ 好友的回合不会再触发群主交办。和好友的单聊记忆不变。

- 解析在 `src/domain/mentions.ts`：名字按长度优先，支持全角 ＠、`@ 名字` 中间空格，邮箱里的 @ 不算。
- 点名好友时前端不发送群主选中的 `model/providerId`，避免把群主的模型硬塞给 TA。

## 视觉插件

好友资料里可开「视觉插件」并指定视觉提供方 / 模型（留空沿用好友默认）。会话最近消息里有图片时，本回合切到视觉模型；图片从 `data/media` 读成 data URL 内联给模型（最多 4 张、单张 4MB、合计 8MB），纯文字回合仍用默认模型。图片过大或读不到时退回 `[图片: 名称]` 文本标签。视觉模型必须支持图片输入；当前好友默认模型不支持时，在插件里换一个视觉模型即可。

## 定时任务

任务页可选「手动 / 定时」。保存时校验 5 段 Cron（分 时 日 月 周），支持 `*`、`a`、`a-b`、`a,b`、`*/n`、`a-b/n`，周日写 `0` 或 `7`。服务进程存活时每 15 秒扫一次：命中当前分钟、同一分钟没跑过、任务启用且没在运行，就自动跑一次，结果写进任务历史；任务页每 10 秒刷新状态和历史，并显示「下次运行」。Cron 按本机时区解释；服务停着时错过的分钟不会补跑。

## 群主指派

只在 `kind: "group"` 且群成员里有群主（`isOwnerTemplate`，冷启动 id 仍是 `role-owner`，语义是默认好友）时可用。输入区「指派给好友」选群内其他好友并写下任务。群里先出现指派卡，被指派的好友按自己的提供方和模型执行，结果消息写回**同一条群会话**，状态从 `pending` 到 `done`。失败时指派保持 `pending` 并带上可读 `error`，可以重试；取消则标成 `cancelled`，不写结果。

被指派好友按 harness 式「开发回流」执行：有工具时走多轮循环（模型调工具 → 工具结果回流 → 继续下一步），最后收口成一段结果；好友绑定工作目录时才带 `workbench_fs_*` / `workbench_shell` 编码工具，未绑定则只出方案并提示先绑定，不会假装执行。执行中的进度人话写进 `assignment.progress`，完成后清掉；实际工具步数写进 `assignment.steps`，结果卡显示「执行 N 步」。模型把工具调用写成 `< | | DSML | | ...>` 之类文本时，会先二次收口，仍不行则隐藏原始标记并给出人话，不把标记回流到群里。

- `POST /api/conversations/:id/assignments` 正文 `{ toFriendId, instruction }`
- `POST /api/assignments/:id/retry`
- `POST /api/assignments/:id/cancel`

指派卡和结果卡挂在消息上：`kind: "assign" | "result"`，并用 `assignmentId` 对上记录。`resultMessageId` 指向回流的那条消息。执行期间页面按 `assignment.progress` 轮询刷新，不需要手动切会话。

## 手工保存技能

这和模型提案的确认卡不是一条路。聊天里点「保存为技能」，填名称、看从本段用户发言拆出的步骤、选一个好友。点确认才写入 `skills`：`scope: "friends"`、`friendIds`、`steps`，正文 `body` 仍是编号文本。取消不落库。好友编辑页「已挂技能」列出这些记录，可以移除。

- `GET /api/skills?friendId=`
- `POST /api/skills` 正文 `{ name, friendId, steps }`
- `DELETE /api/skills/:id?friendId=` 从该好友摘下；只挂着这一个好友时整条删除


## 好友 / 项目长期记忆（p0.4）

挂在**好友**或**项目/群**上的跨会话持久事实，和「会话摘要」不是一回事：摘要只服务当前会话；长期记忆换线程还在，并单独作为系统消息注入后续模型回合。

每条记录：`scope`（`friend` | `project`）、`ownerId`、`fact`、`source`（`auto` | `manual`）、`injectEnabled`、可选 `pinned`、`updatedAt`（界面按 **Asia/Shanghai** 展示）。作用域还有总开关：关掉后该主人下条目一律不注入。

聊天顶栏蓝色 `.chip-ltm`「长期记忆 · N」和蓝色 `.memory-banner-ltm`「已注入好友长期记忆」；绿色仍是会话摘要。好友编辑页与群设置可预览、添加、删除；聊天里「管理记忆」面板可增删改、单条停注入、作用域总开关。

- `GET /api/long-term-memories?scope=&ownerId=`
- `POST /api/long-term-memories` 正文 `{ scope, ownerId, fact, source?, injectEnabled?, pinned? }`
- `PATCH /api/long-term-memories/:id` 正文 `{ fact?, injectEnabled?, pinned? }`
- `DELETE /api/long-term-memories/:id`
- `POST /api/long-term-memories/inject-pref` 正文 `{ scope, ownerId, injectEnabled }`
- `GET /api/conversations/:id/thread` 额外带回 `longTermMemories` 与 `skillSuggestions`

## 建议保存为技能（p0.4）

当前会话近 7 天内用户话术重复达到 3 次时，系统出示确认卡「建议保存为技能」（不是手动「保存为技能」）。**忽略 / 取消不会写入 `skills`**；只有点确认才会按 p0.3 同一套挂载模型写入技能，并出现在好友「已挂技能」。可选「以后不再建议类似模式」。

建议草稿存在 `skillSuggestions`（`pending` | `accepted` | `dismissed`）。`pending` 不是真技能。

- `GET /api/conversations/:id/skill-suggestions`
- `POST /api/skill-suggestions/:id/accept` 正文 `{ name?, scope, friendIds?, muteSimilar? }`
- `POST /api/skill-suggestions/:id/dismiss` 正文 `{ muteSimilar? }`

## 设置：MCP 和保险库

顶栏「设置」里有两个页：MCP、保险库。

MCP 使用官方 `@modelcontextprotocol/sdk`，这一阶段只用工具（`tools/list`、`tools/call`）。资源与提示以后再加。

每条服务要写：名称、传输方式（`stdio`、`sse` 或 `http`）、stdio 的命令和参数，或 sse/http 的 URL 和请求头，以及是否启用。环境变量和请求头都可以加多条，引用字段是 `vaultEntryId`。

设置页可以连接、断开，并看到连接状态和只读的工具列表。发送消息时，已启用且能连上的服务会把工具交给模型（OpenAI tools/functions）。模型如果发起调用，工作台会执行 `tools/call`，最多来回 4 轮，然后要一段最终文字。连不上的服务会被跳过，不会取消这次发送。取消回合仍然会中止进行中的模型请求和工具调用，并且不写记忆。

保险库保存命名的 API Key，或一组用户名和密码。值用 AES-256-GCM 加密后放在 `data/`，主密钥是 `data/vault.key`（创建时尽量设成仅当前用户可读）。提供方和 MCP 可以用条目 id 引用它，不必反复粘贴。

这不是完整的磁盘加密。能同时读到 `vault.key` 和数据文件的人仍然可以解开。请把 `data/` 留在这台电脑上，不要提交到仓库，也不要当成对抗本机管理员的保险。

## 头像

好友记录上的 `avatar` 形如 `{ kind: "default" | "upload", id?, path? }`。

- 内置图在 `src/assets/avatars/`，页面从 `/avatars/defaults/<id>.svg` 读取。群主默认是「印」。
- 上传的 PNG、JPEG、WEBP、GIF 写到 `data/avatars/`，经 `/avatars/files/<文件名>` 提供。不接受 SVG 上传。
- `GET /api/avatars/defaults` 列出内置图。`POST /api/avatars` 上传。保存好友时 `POST /api/friends` 或 `PUT /api/friends/:id` 会带上 avatar。服务端不信任客户端自己写的 path。
- 群头像存在 `Conversation.avatar`，结构相同；群设置里可上传 / 更换 / 恢复默认。`POST /api/conversations` 与 `PUT /api/conversations/:id` 接受 `avatar`（`null` 表示恢复默认），群列表和聊天顶栏同步显示，`/new-chat` 的新线程继承群头像。路径同样由服务端校验。

## 冷启动会写入什么

空库第一次打开时写入预设，已有同 id 的记录不会被覆盖；缺的预设 id 会在后续启动补上：

- `ollama-local`：名称「Ollama 本地」，`http://127.0.0.1:11434/v1`，不需要 API Key，默认启用
- `lmstudio-local`：名称「LM Studio 本地」，`http://127.0.0.1:1234/v1`，密钥可选，默认启用
- `openai`：名称「OpenAI」，`https://api.openai.com/v1`，必须有密钥，默认停用
- `deepseek`：名称「DeepSeek」，`https://api.deepseek.com/v1`，必须有密钥，默认停用
- `dashscope`：名称「阿里云百炼」，`https://dashscope.aliyuncs.com/compatible-mode/v1`，必须有密钥，默认停用，默认模型 `qwen-plus`；通义千问视觉模型可填 `qwen-vl-plus` / `qwen-vl-max`
- `cursor`：名称「Cursor」，`https://api.cursor.com/v1`，必须有密钥，默认停用，默认模型 `composer-2.5`。预设列表是 Cursor 自有模型：`composer-2.5`、`composer-2.5-fast`、`grok-4.7`、`grok-4.7-fast`、`grok-4.6`、`grok-4.6-fast`、`grok-4.5`、`grok-4.5-fast`、`auto-smart`。在 [Cursor Dashboard](https://cursor.com/dashboard) 建用户 API Key，写入保险库后点「探测模型」；官方 `GET /v1/models` 的 `items` 会按账号覆盖这份列表。发送时不走 `/chat/completions`（官方没有这条），而是用同一把 Key `POST /v1/agents` 开一次无仓库的 Cloud Agent，读完回复后删掉这次智能体。账号需要能创建无仓库的 Cloud Agent。
- 好友「群主」，`isOwnerTemplate: true`，头像为默认「印」，提供方指向 `ollama-local`。它的 id 仍是 `role-owner`。这是历史原因：早期冷启动用过这个字符串，继续用它是为了不把已有好友拆成另一条。语义是默认好友 / 群主，不是「角色」实体。同时种入一条挂在这个好友上的单聊，所以「全部」和「好友」一打开就能看到群主。
- 旧字段名 `roles`、`roleIds`、`speakerRoleId`、`fromRoleId`、`toRoleId` 在打开时迁成 `friends`、`friendIds`、`speakerFriendId`、`fromFriendId`、`toFriendId`。这些只是历史字段名。

某张表被清空后，只补缺失的预设 id。已经改过名称或地址的记录不会被种子盖回去。没有头像字段的旧好友会补上默认印。

## 目录

后续阶段往这些边界上加，而不是重做存储或模型客户端。

| 路径 | 现在 | 接下来 |
| --- | --- | --- |
| `src/server.ts` | Node 宿主：页面 + `/api` | 仍由它对外 |
| `src/storage` | `agent_workbench` v1：providers、friends、conversations、messages、runs、summaries、skills、assignments、secrets、mcpServers、tasks、proposals | 旧 `roles` 打开时迁成 `friends` |
| `src/llm` | `listModels`、`chat`、`chatStream`，工具参数走 OpenAI tools | 单聊与工具回合共用 |
| `src/vault` | AES-256-GCM 保险库，`data/vault.key` | 仍只存本机 |
| `src/mcp` | 官方 SDK：stdio / sse / http，仅 tools/list 与 tools/call | 资源与提示以后再加 |
| `src/app` | 提供方、探测、会话、好友、头像、保险库、MCP 配置 | 发送回合的用例 |
| `src/session` | 5 秒排队、取消、最多 4 轮工具后再要最终文字 | 防重、排队发送 |
| `src/memory` | 读取已有摘要；取消的回合不写记忆 | 摘要记忆 |
| `src/skills` | 列出草稿 | 手工技能 |
| `src/ui` | QQ 式主壳：会话列表 + 气泡；侧栏无好友。齿轮进好友编辑，群齿轮进群设置 | 对齐交互 |

`runs` 的幂等键在写入时保持唯一，留给发送防重。


## p0.5 · MCP 市场与 Resources/Prompts

- 本地 catalog：`GET /api/mcp/catalog`，启用：`POST /api/mcp/catalog/:id/enable`（scope 全局 | 指定好友 | 指定群；未确认不写）
- 群设置里的「群 MCP」只属于这个群（`scope=groups`，按 lineage 记）。同一群另起一段仍然可用。发送时只带：全局服务、当前发言好友的服务、以及本群服务。
- Resources / Prompts：`GET /api/mcp/:id/resources` · `GET /api/mcp/:id/prompts`；选用插入当前 composer
- 已配置 ⇄ 市场分段；设置枢纽含「MCP 市场」入口；主壳聊天无市场面板

## p0.8 · 会话内提议创建

模型通过内置工具 `workbench_propose` 在会话内出示 **ConfirmCard**（对齐 `agent-chat-ui/propose.html`）：

1. **作用域先问清**：全局 | 指定好友（未选有效作用域时确认钮禁用）
2. **确认门闩**：pending 只存在 `proposals`；确认才写入 `skills` / `mcpServers` / `tasks`
3. **取消丢草稿**：`POST /api/proposals/:id/cancel` 删除 pending
4. **失败整笔回滚**：confirm 失败记 `proposal.error`，status 仍 pending，本体零写入，可重试
5. **kind** = `skill` | `mcp` | `task`（≠ 系统建议技能 SkillSuggestion；≠ MCP 市场 `enableFromCatalog`）

演示稿：`propose.html` / `shots/propose.png`（失败态 `propose-fail.png`）。


## p0.8.1 · Markdown / 好友默认模型 / 提议创建好友

1. **气泡 Markdown**：助手/用户正文按轻量 Markdown 渲染（`.bubble.markdown` / `.bubble-md`），`**粗体**`、列表、行内代码等不再露出生星号。
2. **好友默认模型**：顶栏选模型后写入 `Friend.defaultModelId`（及提供方）；同好友下次打开 / 新会话沿用，可再改。
3. **`workbench_propose` kind=`friend`**：确认卡改名字（必填）、人设、可选默认模型；确认才写入通讯录。取消丢草稿。通讯录「＋ 新建好友」入口仍保留，提议不是唯一创建路径。

UI 定稿参考：`agent-chat-ui/markdown-bubble.html`、`index.html`（model-default）、`propose.html?kind=friend`。


## p0.9 · 分层记忆加深

1. **三层可辨**：工作记忆（灰）/ 会话摘要（绿）/ 好友·项目长期（蓝）；顶栏「记忆 · 三层」统一面板。
2. **写入 toast**：摘要自动/手动写入、长期新增后右下角非挡提示。
3. **本回合注入来源**：助手气泡上方来源条（工作 · N / 摘要 · 开|关 / 长期 · N · 作用域），可点预览。
4. **摘要 ≠ 长期**：系统提示与 UI 文案/配色均区分；可「升为长期…」确认门闩。

保留 p0.8.1：气泡 Markdown、`Friend.defaultModelId`、`propose kind=friend`。

UI 定稿：`docs/p09-ui/layered-memory.html` + `layered-memory.png`。

## p1.0 · 联调收口

不扩新功能。方案见 [`docs/p1.0-integration-plan.md`](docs/p1.0-integration-plan.md)。

1. **Ollama / 线上实聊冒烟**：探测模型 → 选默认/好友模型 → 真打上游一句；失败为人话。自动化测默认 skip，强制：`OLLAMA_SMOKE=1`。
2. **MCP 真 tools 一次调用**：离线用 [`scripts/mcp-echo-server.mjs`](scripts/mcp-echo-server.mjs)（stdio：`node` + 该脚本）→ 启用/预览 → hub `callTool`；`test/p10-mcp-smoke.test.ts` 锁回归。
3. **密码库引用 Provider**：条目只留 `vaultEntryId`；探测/发送从保险库 reveal，不落明文。
4. **建好友 + 默认模型 + MD**：`propose kind=friend` 确认门闩、`Friend.defaultModelId`、气泡 Markdown（p0.8.1 仍在）。

## p0.7 · 思维链可折叠

助手消息可带可选字段 `reasoning`。仅当模型产出 reasoning / reasoning_content 时，气泡上方显示可折叠思维链（默认收起；流式中为「正在思考…」）。正式回复仍走 `content`，历史回灌默认不带 reasoning。非挡：仅附件无正文可发；输入区保持单一 attach 按钮。

## p0.6 · 富媒体（图 / 附件）

输入区可添加图片或附件：先 `POST /api/media` 上传，再在 `POST /api/conversations/:id/send` 里带 `attachmentIds`。无附件时纯文字路径与 p0.5 相同。气泡内可预览图片（lightbox）、附件可下载（`/media/files/:name?download=1`）。

- `POST /api/media` multipart 字段 `file` → `{ attachment }`
- `GET /media/files/:fileName` 预览；加 `?download=1` 下载
- 消息字段 `attachments?: MessageAttachment[]`


## p1.1.3 · 会话摘要事件化

- 摘要改为**事件列表**（请求 / 决策 / 确认卡 / 落库 / 未决），禁止贴整段气泡原文。
- 单会话硬顶 **≤1000 汉字**；超出合并旧事件为粗粒度。
- 增量改写事件（同键覆盖），不线性拼接全量消息进摘要/注入。
- 确认卡：未确认写「待确认」，确认后写「已保存」。
- 面板标题「事件摘要」；chip「摘要已注入」保留。

基线 zip：`local-agent-workbench-p1.1.3.zip`（叠在 p1.1.1/1.1.2 设置行为之上）。

## p1.1.1 / p1.1.2（同包）

- **p1.1.1** 设置「快捷入口」：名称靠左，描述单独下一行左齐，chevron 右居中，无楼梯。
- **p1.1.2** 发送后等待窗口：−/N秒/+ 步进器，全局 1–10 秒可配并持久化；**默认 5 秒**；会话文案动态「约 N 秒…」；终止回填不变。测试仍可用 `sendDelayMs` / `SEND_DELAY_MS` 覆盖。

基线 zip：`local-agent-workbench-p1.1.1.zip`（含上两项，不另打 p1.1.2）。

## p1.1 验收（本地代码开发）

基线：`local-agent-workbench-p1.0` → 本包 zip `local-agent-workbench-p1.1.zip`。  
策略：能力对齐 deepseek-harness + **自研薄工具层**；不嵌 dsh / 不开 IDE 壳。

### 验收勾选

- [ ] 好友设置有「工作目录」：可选目录（文本绝对路径）、可不选、可清除/切换；未选时编码工具全禁，聊天照常；磁盘零访问
- [ ] 绑定后只读工具 `workbench_fs_list` / `read` / `grep` 可用，回复可含相对路径
- [ ] 写文件走 `code-diff` 确认卡：**确认前**目标文件不变；确认后变更可核对；取消后不变
- [ ] shell 走 `code-shell` 确认卡：批准后回传 exit code + 日志尾；拒绝未执行
- [ ] Workspace 外路径 → 人话拒绝
- [ ] 会话内可折叠「工具时间线」可回看读 / 写确认 / shell 确认
- [ ] 危险全开：写 / 删 / shell 在 Workspace 内直接执行，不再逐次确认；越界仍拒绝
- [ ] `node --test test/*.test.ts` 全绿（含 code-* 与 HTTP 联调）
- [ ] 交付 zip（无 node_modules / data / dist / .git）到 Downloads

### API（本包）

- `PUT /api/friends/:id` 可读写 `workspacePath` / `codePermission`（空字符串清除）
- `GET /api/conversations/:id/code-actions` · `POST /api/code-actions/:id/confirm|cancel`
- `GET /api/conversations/:id/code-timeline`

### UI

- 好友设置：`.ws-bind`（空态 / 清除 / 权限三档）
- 会话：`.code-diff` / `.code-shell` ConfirmCard + `.tool-timeline`；顶栏 `.chip-ws`


## p1.2 · 邮箱工作指令 + 输入框上方设置栏 / 计划模式

技术方案：`docs/p1.2-mail-composer-plan.md`。基线自 p1.1.3。UI 定稿：`agent-chat-ui/composer-toolbar.html` · `mail-work-inbox.html` · `workspace-bind.html`（p1.2.1 选文件夹）。

### 验收勾选

- [ ] 输入框**上方**设置栏：模型、保存技能、新会话、对话模式（普通/计划）、推理程度；底栏仅附件+发送
- [ ] 计划模式：系统提示词来自设置（可编辑·恢复默认）；写 MD 到 `/tmp/agent-workbench/plans/`；「开始执行」确认卡；确认前不可副作用；确认后逐步 `[x]`
- [ ] 设置「邮箱 / 工作指令」：IMAP/SMTP、白名单、启用、轮询默认 10 分钟、密钥走密码库；启用后群主有拉信任务；回信只结果摘要
- [ ] 邮件工作提示词可在设置里编辑/恢复默认；默认按无人值守写（不反问、不等确认、最后给可回信的结果）
- [ ] 邮件任务默认「无人值守自动执行」：写文件 / shell 直接落地，不出确认气泡；仍受工作目录与代码权限限制。跑完等模型收口后 SMTP 回真实结果，不是只回“已下发”
- [ ] 好友工作目录：**主路径「选择/更换文件夹」**（`POST /api/workspace/pick-folder` 原生对话框）+ 只读路径 + 清除解绑；高级折叠「粘贴路径」兜底；空态保留
- [ ] 非计划模式行为不被破坏；全量 `node --test test/*.test.ts` 绿

### API（本包）

- `PATCH /api/conversations/:id/composer` · `{ chatMode?, reasoningLevel?, model? }`
- `GET|POST /api/conversations/:id/plans` · `POST /api/plans/:id/confirm|cancel` · `POST /api/plans/:id/steps/:i/done`
- `PUT /api/settings` 可写 `mailInstructions` / `planModePrompt`
- `POST /api/workspace/pick-folder` → `{ path }`（macOS `osascript` / Linux `zenity|kdialog` / Windows PowerShell；测例可 mock / `WORKBENCH_MOCK_FOLDER`）

### UI

- 会话：`.composer-toolbar` + 计划 chip / `.plan-confirm`；设置：邮箱页 + 计划提示词
- 好友：`.ws-bind` 选文件夹主路径 + `.ws-advanced` 粘贴兜底

### 已知缺口

- 真 IMAP/SMTP 本机冒烟（本包已接真协议 + mock 单测；真端点需本机配齐）
- LLM 回合结束后自动解析助手 MD 再 `draftPlan`（当前计划模式发消息会起草骨架计划，确认卡可用）
