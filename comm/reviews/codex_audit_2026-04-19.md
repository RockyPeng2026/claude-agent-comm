# Codex Audit — 2026-04-19

## Summary
- critical: 1 / high: 5 / medium: 3 / low: 0 / nit: 0
- verdict: NOT READY TO OPEN SOURCE
- top 3 blockers: `launch_child.js` 通过 `psmux send-keys` 明文注入 Anthropic 凭证；`kill/status/send` 对 `--session` 缺少统一校验导致路径穿越面；仓库声明 MIT 但根目录没有 `LICENSE`

## Findings

### [CRITICAL] #1 — Claude 凭证被拼进 `psmux send-keys` 文本，直接落入会话滚动缓冲
**File**: `comm/launch_child.js:250-267`
**Category**: 隐私
**Issue**: Claude runtime 分支把 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`API_TIMEOUT_MS` 直接拼进 PowerShell `cmdLine`，随后用 `psmux send-keys -l` 送进 session。这样凭证会出现在 pane scrollback、任何 attach 到该 session 的终端、以及可能的 psmux/tmux 历史缓冲里。
**Impact**: 这是发布前必须消除的直接凭证泄露面。只要 session 被 attach、录屏、转储，token 就会暴露；README 还鼓励用户长期保留 session 管理子 agent，这会放大泄露窗口。
**Fix**: 删除 `250-258` 对 `$env:ANTHROPIC_*=` 的字符串拼接。把 child 启动改成“进程环境传值，而不是 typed command”：在 `208-209` 处直接用 `psmux new-session -d -s <name> pwsh ...` 启动 bootstrap 命令，并在 `spawnSync(..., { env: { ...process.env, CLAUDE_CHILD_HOOKS:'1', CLAUDE_CHILD_SESSION:sessionName, CLAUDE_CHILD_SIGNAL_DIR:signalDir, CLAUDE_PROJECT_DIR:PROJECT } })` 中传递所有敏感 env；`263-267` 只保留非敏感 prompt/send 行为，不再把 token/base URL 发到终端输入缓冲。

### [HIGH] #2 — 原样持久化 `passthrough` 参数，会把 prompt/密钥类 flag 写进 registry 并经 `list/status` 回显
**File**: `comm/launch_child.js:165-185`, `comm/launch_child.js:217-220`, `comm/launch_child.js:316-321`, `comm/launch_child.js:349`
**Category**: 隐私
**Issue**: `launch` 把所有未知参数收进 `passthrough`，随后原样落盘到 `.claude/signals/sessions/{session}.json`，`list` 和 `status` 还会把它完整打印出来。
**Impact**: 用户若通过 passthrough 传 `--prompt`、`--api-key`、`--base-url`、文件路径、工单号或其他 PII，这些信息会被长期写盘并在状态查询时再次暴露。该风险与上面的 token 泄露独立存在。
**Fix**: 删除 `217-220` 和 `138-140` 中对 `passthrough` 的持久化；`316-321` / `349` 输出前显式 `delete data.passthrough`。如果确实需要审计信息，只保留 allowlist 后的非敏感 flag，或改成 `passthrough_count` / `passthrough_redacted`。

### [HIGH] #3 — `kill/status/send` 未校验 `--session`，可通过路径穿越读写 sessions 目录外的 JSON
**File**: `comm/launch_child.js:25-31`, `comm/launch_child.js:281-305`, `comm/launch_child.js:326-349`, `comm/launch_child.js:354-375`
**Category**: 安全
**Issue**: `launch/register` 对 session 名做了 `^[A-Za-z0-9._-]+$` 校验，但 `kill/status/send` 没有。`readRegistry(session)` 直接 `path.join(SESSIONS_DIR, \`${session}.json\`)`，`kill` 还会对同一路径执行 `unlinkSync` 并写 tombstone。
**Impact**: 传入 `..\..\some\file` 之类的 session 值时，代码会尝试读取、删除或写入 `SESSIONS_DIR` 之外的 `.json` / `.tombstone.json` 路径。只要目标文件是合法 JSON，就可能被当成 registry 处理，属于明确的路径穿越面。
**Fix**: 抽出统一的 `assertValidSessionName(value, flagName)`，并在 `readRegistry`、`cmdKill`、`cmdStatus`、`cmdSend` 刚拿到值时立即调用，规则与 `launch/register` 保持一致。作为第二层防线，把 `regPath` / `tombPath` 都改成 `path.resolve(...)` 后校验必须以 `SESSIONS_DIR + path.sep` 为前缀，否则直接 `exit 1`。

### [HIGH] #4 — `kill` 写出的 tombstone 永不清理，复用同名 session 后 watcher 仍会永久丢弃信号
**File**: `comm/launch_child.js:131-147`, `comm/launch_child.js:216-223`, `comm/launch_child.js:291-305`, `hooks/watch_child_stream.js:45-54`
**Category**: 规范
**Issue**: `kill` 会创建 `{session}.tombstone.json`，watcher 看到 tombstone 就无条件丢弃该 session 的所有 signal；但 `launch` 和 `register` 成功时从未清除同名 tombstone。
**Impact**: README 的示例 session 名如 `mywork` 一旦被 `kill` 过，再次 `launch --session mywork` 时 registry 能成功写入，但 watcher 会继续把新 signal 当成“已 tombstone 的旧 session”丢弃，父侧表现为静默失效。
**Fix**: 在 `launch` 的 `216` 行之前，以及 `register` 的 `146` 行之前，显式删除同名 stale tombstone；若不想自动删除，就在发现 tombstone 时 fail fast 并提示用户执行专门的 `clear-tombstone`/`--reuse-session` 流程。无论哪种方案，都要让新 session 与旧 tombstone 生命周期解耦。

### [HIGH] #5 — 文档和项目规则宣称 Unix `tmux+bash` 对等支持，但实现只有 `psmux+PowerShell`
**File**: `README.md:40-41`, `CLAUDE.md:18`, `comm/launch_child.js:34-38`, `comm/launch_child.js:208-267`
**Category**: 文档
**Issue**: README 和根 `CLAUDE.md` 都把 `*nix (tmux+bash)` 写成既有能力；实际代码从 session 枚举、创建、kill、send 到 bootstrap 文本构造全部硬编码为 `psmux` + PowerShell。
**Impact**: Linux/macOS 用户按 README 操作会立即失败，这不是“文档不完善”，而是对发布能力边界的错误陈述。开源首发时这是高概率踩坑项，也会降低仓库可信度。
**Fix**: 二选一，且发布前必须完成其一。短期止血方案：把 `README.md:40-41` 和 `CLAUDE.md:18` 改成“当前仅支持 Windows(psmux+pwsh)”。正确长期方案：在 `launch_child.js` 中按 `process.platform` 实现 tmux/bash 对等分支，覆盖 `ls/new-session/kill-session/send-keys` 与 bootstrap 命令构造后，再恢复对等支持声明。

### [HIGH] #6 — README 声称 MIT，但仓库根目录没有 `LICENSE`
**File**: `README.md:74-76`
**Category**: 开源成熟度
**Issue**: 仓库对外声明 MIT，但当前根目录没有任何 `LICENSE` 文件。
**Impact**: 这会让项目在法律上处于“未授予使用许可”的状态。对外发布到 GitHub 时，用户和公司法务都无法把它视为标准开源项目采用。
**Fix**: 在仓库根目录新增标准 MIT `LICENSE` 全文；如果最终不是 MIT，则同步修改 `README.md:74-76`，避免仓库声明与实际授权文本不一致。

### [MEDIUM] #7 — 发布配套文件缺失，和仓库内定义的协作/测试流程不匹配
**File**: `CLAUDE.md:23-30`, `CLAUDE.md:45-59`
**Category**: 开源成熟度
**Issue**: 项目内部已经定义了 PR、issue、测试、文档职责和里程碑流程，但仓库缺少 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CHANGELOG.md`、`.github/workflows/`、issue template、PR template。
**Impact**: 对外发布后，外部贡献者没有统一入口，安全报告没有披露渠道，CI 也无法在 Windows/Linux 上自动验证最核心的 Node 脚本。项目会呈现“有内部流程、无公开运营面”的半成品状态。
**Fix**: 补齐最小开源基建：`CONTRIBUTING.md`（开发/测试/发布流程）、`CODE_OF_CONDUCT.md`、`SECURITY.md`（报告邮箱/响应 SLA）、`CHANGELOG.md`、`.github/workflows/ci.yml`（至少覆盖 Windows + Linux 的 smoke test）、`.github/ISSUE_TEMPLATE/*` 与 `.github/pull_request_template.md`。

### [MEDIUM] #8 — `send/kill/status` 的参数解析不健壮，`--text` 后跟 `--xxx` 会被误吞
**File**: `comm/launch_child.js:283-285`, `comm/launch_child.js:328-330`, `comm/launch_child.js:356-361`
**Category**: 规范
**Issue**: 这三个 subcommand 的解析逻辑只检查“后面还有没有 token”，不检查下一个 token 是否本身是新选项。结果 `send --text --foo` 会把 `--foo` 当成正文，`kill --session --foo` / `status --session --foo` 也会接受一个明显非法的 session 值。
**Impact**: CLI 行为与 `launch/register` 不一致，用户一旦传入以 `--` 开头的正文或漏写值，会得到难以诊断的错误；这正是发布后高频被提 issue 的那类参数坑。
**Fix**: 复用 `launch/register` 现有的“缺值或下一个 token 以 `--` 开头则报错”逻辑；同时增加一种显式发送 option-like 文本的写法，例如支持 `send --text=--foo` 或 `send --text -- --foo`，并在 usage/README 里写明。

### [MEDIUM] #9 — README/模板不足以让零基础用户完成安装和排障
**File**: `README.md:38-54`, `README.md:72`, `install.js:53-59`, `codex-config/config.toml.template:1-6`
**Category**: 文档
**Issue**: README 只列出“需要 psmux + PowerShell 7 + Node.js 18+”，但没有解释 psmux 是什么、如何安装/验证、Codex `notify` 模板为什么必须改成绝对路径、Windows 路径转义如何写、信号不工作时先查哪里。`install.js` 也只打印“手动 merge/copy”提示，没有给出可复制的完整结果示例。
**Impact**: 首次使用者很难区分“项目没装对”和“子 agent 本身没跑起来”。尤其在 Windows 上，绝对路径、`$CLAUDE_PROJECT_DIR`、hook shell、stale tombstone 都是高概率故障点。
**Fix**: 在 README 增加四块内容。第一，Prerequisites：`node -v`、`pwsh -v`、`psmux --help`/`tmux -V` 的安装与验收命令。第二，Setup：`settings.local.json` 合并后的完整示例，以及 `config.toml` 的 Windows/Unix 绝对路径示例。第三，Troubleshooting：`psmux not found`、hook 无 signal、`CLAUDE_PROJECT_DIR` 缺失、复用 session 名失败、watcher 没输出。第四，明确说明当前支持平台和已知限制，不要让用户从 `comm/CLAUDE.md` 的实现细节里自己拼答案。
