---
name: git-commit-zh
description: >-
  先拉取远程再提交并推送本仓库（KeJin-Liu/local-agent-workbench），中文 commit
  须写明改动、重构、功能。Use when the user asks to 提交 / commit / git commit /
  提交代码 / 提交改动 / 推送 / push。
---

# 本仓库中文提交与推送

## 可提交范围（硬性）

只在本仓库根目录操作。远程是 `origin` → `https://github.com/KeJin-Liu/local-agent-workbench.git`，默认分支 `main`。

- 禁止在上级目录（如 `Desktop/`）建仓库或提交。
- 没有改动且没有未推送的 commit 时，不要空提交、不要空推。

## 禁止提交（硬性）

下列路径即使出现在工作区，也不要 `git add`，更不要 `git add -f`：

| 路径 | 说明 |
|------|------|
| `data/` | 会话、`agent_workbench.json`、`vault.key`、头像、附件。密文和主密钥在一起就能解开保险库 |
| `.env`、`.env.*`、`*.pem`、`*.key` | 本地环境与密钥。`.env.example` 可以提交 |
| `node_modules/`、`dist/`、`.pnpm-store/`、`.audit/` | 依赖、构建产物、本机 Playwright 浏览器 |
| `package-lock.json` | 本仓库用 pnpm，锁文件是 `pnpm-lock.yaml` |
| `coverage/`、`*.log`、`*.tsbuildinfo`、`playwright-report/`、`test-results/` | 工具输出 |

提交前看 `git status`。若上述路径仍被列出，先确认 `.gitignore` 已覆盖；已跟踪的密钥文件不要 `git rm --cached` 后强推，先停下来告诉用户。

## 提交流程（硬性顺序）

有本地改动，或已 commit 未 push 时，**必须按此顺序**：

1. **先更新代码**：在仓库根目录 `git fetch`，再 `git pull --rebase`。有未提交改动时先 `git stash push -u`，rebase 完成后再 `git stash pop`。有冲突则解决后 `git rebase --continue`，禁止擅自 `rebase --abort` 丢弃用户改动。
2. **再提交**：按下方中文模板 `git add` + `git commit`。本步无新改动、仅待推送则跳过。
3. **再推送**：跟踪分支已存在时用 `git push`；新分支用 `git push -u origin HEAD`。**默认要 push**，不要只 commit 不推。

用户说「只提交不推送」时才跳过第 3 步。

## 提交信息（必须中文）

每条 commit message **必须用中文**，且正文说清三件事（缺一不可）：

1. **改了什么**：新增/修改/删除了哪些模块、接口、页面、配置、文档。
2. **重构了什么**：若无重构，写「无重构」；有则说明动机与范围。
3. **什么功能用到了**：本次改动服务哪些页面或能力（会话、好友、群、提供方、保险库、MCP、邮箱工作指令、计划模式、代码工作区等）。

不要写 `Co-authored-by`、`Made with Cursor` 或任何 Cursor 署名行。

### 推荐格式

```text
<一句话标题：动词开头，点明模块与动作>

改动：
- ...

重构：
- ...（或：无重构）

功能：
- ...
```

标题可用简短前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`，其余必须中文。

### 示例

```text
feat: 接通邮箱工作指令的真 IMAP 与 SMTP

改动：
- 拉信用 imapflow，回信用 nodemailer，密码只读保险库
- 连接失败把人话写进任务历史

重构：
- 无重构

功能：
- 设置-邮箱/工作指令（拉信、白名单、回结果摘要）
```

```text
fix: 探测模型时保留已填写的 API Key

改动：
- 提供方编辑页「探测模型」只刷新已探测列表，不清本轮 Key、保险库引用和 Base URL

重构：
- 无重构

功能：
- 设置-模型（OpenAI / DeepSeek / 兼容提供方的探测）
```

## 执行步骤

在仓库根目录依次执行：

1. 并行查看：`git status -sb`、`git diff`（含已暂存）、`git log -5 --oneline`、与上游的 `ahead` / `behind`。
2. **拉取**：`git pull --rebase`（behind，或 ahead 且 behind 时，必须先 rebase 再 push）。
3. 只 `git add` 相关文件。不要提交密钥、`.env`、`data/`、`node_modules/`、`dist/`、`.audit/`、`package-lock.json`。
4. 按上方模板用 HEREDOC 提交：

```bash
git commit -m "$(cat <<'EOF'
标题

改动：
- ...

重构：
- ...

功能：
- ...

EOF
)"
```

5. **推送**：`git push`（或 `git push -u origin HEAD`）。
6. 推送后 `git status -sb`，确认与 `origin` 同步。
7. 若 hook 失败：修复后**新建** commit，不要 `--amend`（除非用户明确要求且满足安全条件）。

## 安全红线

- 不改 git config。
- 不用 `push --force` / `--force-with-lease`（除非用户明确要求）。`main` 未设分支保护，强制推送会直接改写 GitHub 上的历史。
- 不用 `-i` 交互命令。
- 不跳过 hooks（`--no-verify`），除非用户明确要求。
- 用户未说「提交」或「推送」时，不要擅自 commit 或 push。
