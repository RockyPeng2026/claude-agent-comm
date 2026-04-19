# claude-agent-comm

父子 Claude Code agent 通信框架。父 Claude 通过 psmux/tmux 启动子 CLI（claude / codex / 其他），子进程的 hook 写 signal 文件，父侧 watcher emit 到 Monitor，实现**事件驱动、非阻塞、多 runtime** 的子 agent 管理。

## 目录

```
comm/                     # 启动器 + 框架文档 + spec
  launch_child.js         # 主脚本：subcommands launch/kill/list/status/send/register
  CLAUDE.md               # 协议文档（hook 事件格式、父 agent 纪律）
  wave*_spec.md           # 历次施工规格
hooks/                    # Hook 回调脚本（装到目标项目的 .claude/hooks/）
  child_signal.js         # Hook 回调 — 写 signal 文件
  watch_child_stream.js   # 父侧 watcher — 读 signal 目录 emit stdout
  codex_hook_bridge.js    # Codex notify → child_signal 适配
codex-config/
  config.toml.template    # codex 项目级 config.toml 模板
examples/
  settings.local.json.example   # Claude Code hooks 配置示例
install.js                # 跨平台 Node 安装脚本（copy 到目标项目 .claude/）
```

## 架构

```
父 Claude Code
  ↓ launch_child.js launch
  psmux / tmux session
  ↓ 跑子 CLI（claude / codex）
  ↓ 子进程 hook 触发（Stop / PermissionRequest / StopFailure / Notification）
  ↓ child_signal.js 写文件
  .claude/signals/child-events/
    {ts}__{session}__{state}__{pid}__{guid}.signal
  ↓ watcher 读 + unlink
  Monitor 捕 stdout → task-notification → 父 Opus 醒
```

## 要求

- **Windows only**（当前版本）：psmux + PowerShell 7 + Node.js 18+
- 目标项目需支持 Claude Code hooks（settings.local.json）

> ⚠️ *nix (tmux + bash) 支持**未实现**；代码路径硬编码 `psmux` + PowerShell。跟进 [issue #N](https://github.com/RockyPeng2026/claude-agent-comm/issues) 或提 PR 加分支。

> 🔐 **alpha 阶段安全提示**：claude runtime 的 env（含 `ANTHROPIC_AUTH_TOKEN`）经 `.claude/signals/session-env/<session>.ps1`（mode 600，source + 立即删）中转，不再进 pane scrollback。但该文件在 Windows NTFS 下 POSIX mode 仅 best-effort，异常退出可能残留。生产凭证建议仍用 z.ai 代理或受限 scope token，不要放 root-equiv 主 key。

## 安装到目标项目

```
node install.js /path/to/myproject [--force]
```

Install 脚本会：
1. Copy `hooks/*.js` 到 `<target>/.claude/hooks/`
2. Copy `comm/launch_child.js` 和 `comm/CLAUDE.md` 到 `<target>/.claude/comm/`
3. 提示用户 merge `settings.local.json.example` 到项目的 `.claude/settings.local.json`
4. Codex 用户另外 copy `codex-config/config.toml.template` 到 `<target>/.codex/config.toml`

## 使用

```powershell
# 起子
node .claude/comm/launch_child.js launch --runtime claude --model glm-5.1 --session mywork

# 发 prompt
node .claude/comm/launch_child.js send --session mywork --text "hello"

# 看状态
node .claude/comm/launch_child.js status --session mywork

# 结束
node .claude/comm/launch_child.js kill --session mywork
```

父侧要配 Monitor 盯 signal 目录（见 `comm/CLAUDE.md` 第 4 节）。

## License

MIT
