# .claude/comm/ — 父子 agent 通信框架

## 1. 概述

父子 Claude 进程间事件信号机制。框架级基础设施，与应用规则（`.claude/rules/`）正交。用于父进程实时感知子进程的 `permission` / `stop` / `stop_failure` 状态，避免轮询屏幕。

代码分布：
- `.claude/comm/launch_child.js` — 子进程启动器（psmux session + env 注入）
- `.claude/hooks/child_signal.js` — Hook 回调（Claude Code 强制放 hooks/）
- `.claude/hooks/watch_child_stream.js` — 父 watcher
- `.claude/signals/child-events/` — 运行时事件目录（gitignored）

以下个人实测经验与官方文档混用，已标注未经官方验证的部分，仅供参考。

## 2. 协议

事件源：子进程的 Stop / PermissionRequest / StopFailure hook。  
事件载体：`$signalDir/{UTC-timestamp}__{session}__{state}__{pid}__{guid8}.signal`（空内容）。  
消费方式：父进程轮询 `$signalDir`，按文件名排序 emit 到 stdout，删除文件。

## 3. 文件

| 文件 | 职责 |
|------|------|
| `child_signal.js` | Hook 回调。必填 `--state`。写唯一文件名到事件目录 |
| `watch_child_stream.js` | 父 watcher。轮询 SignalDir，emit + delete。配合 Claude Code Monitor 使用 |
| `../settings.local.json` `hooks` 段 | 三个事件分别调 `child_signal.js --state {permission|stop|stop_failure}` |

## 4. 启动要求

### 子进程 env
- `CLAUDE_PROJECT_DIR`：**必需**。`settings.local.json` 的 hook command 用 `$CLAUDE_PROJECT_DIR/.claude/hooks/child_signal.js` 定位脚本本身。Claude Code 通常自动注入
- `CLAUDE_CHILD_HOOKS=1`：硬开关。非 `'1'` 时 hook 立即 `exit 0`
- `CLAUDE_CHILD_SESSION`：**必需**。父 `launch_child.js` 自动注入为 psmux session 名
- `CLAUDE_CHILD_SIGNAL_DIR`：事件目录。可选；未设时回退 `$CLAUDE_PROJECT_DIR/.claude/signals/child-events`

### 父 watcher
Monitor 工具启动：
```
node <project>/.claude/hooks/watch_child_stream.js --signalDir <project>/.claude/signals/child-events
```
若 `$CLAUDE_PROJECT_DIR` 已设可省略 `--signalDir`；两者皆无时 `exit 1`。

## 5. 事件格式

文件名：`{UTC-timestamp}__{session}__{state}__{pid}__{guid8}.signal`
- session：父注入的 `CLAUDE_CHILD_SESSION` env（psmux session 名同值）
- timestamp：`yyyyMMddTHHmmss.fffffffZ`，字典序 = 时间序
- 解析：去 `.signal` 后缀 → 按 `__` 分割成 5 段

watcher 丢弃无对应 registry（`.claude/signals/sessions/{session}.json`）或已有 tombstone 的 signal，防止 killed session 残留事件污染。

`state` 取值：
| 值 | 含义 | 父动作 |
|----|------|--------|
| `permission` | 权限对话框出现 | psmux send-keys 批准 |
| `notification` | 子需要用户注意（AskUserQuestion / idle 等待等） | 视上下文决定：等用户 / 发 prompt |
| `stop` | 子空闲 | 发下条指令 |
| `stop_failure` | 子异常终止 | 介入排查 |

## 6. 设计约束

- **不可变事件文件**：文件名含 pid + guid8，碰撞概率低（非数学保证）
- **emit + delete**：watcher 删文件失败可能导致重复投递，消费方须幂等
- **持久化**：父未启动 watcher 时事件留存磁盘，下次 watcher 启动补发
- **失败语义**：
  - watcher 捕获 `EPIPE` 干净退出（管道断开场景）
  - child hook 写入失败仅 stderr，仍 `exit 0`（事件会丢但不阻断子进程）
  - SignalDir 不存在时 watcher 自动创建

## 7. 不支持场景

- 并发父 watcher 共用同一 SignalDir（emit+delete 假设单消费者）
- 低延迟感知：默认 `-PollMs 1000`，通知延迟 ≤ 1s。需要更低调小 `-PollMs` 参数

## 8. 兼容性与已知限制

| 主题 | 说明 | 来源 |
|------|------|------|
| `task-notification` 触发 | `Bash`/`PowerShell run_in_background` 退出时单发；`Monitor` 每行 stdout 多发；`Agent` 工具 run_in_background 完成时单发 | 实测 |
| Codex 插件不触发 task-notification | `task --background` 后台运行但无 push。需父自建 waiter 轮询 `codex-companion status`，waiter 退出才触发通知。参考模板见下方 | 实测 |
| Windows hook shell | Claude Code 默认 bash 执行 hook command；bash 会展开 `$CLAUDE_PROJECT_DIR`。迁移到 Node.js 后无需 `cmd.exe` 中转 | 实测 |
| `.claude/` sensitive 保护 | `--dangerously-skip-permissions` 不豁免 `.claude/rules/` / `.claude/hooks/` 编辑。豁免目录：`.claude/{commands,agents,skills,worktrees}` | 官方 |
| `--permission-mode auto` 前提 | Anthropic API + Team/Enterprise/API 计划 + 模型 Sonnet 4.6 或 Opus 4.6。不满足时底部显示 `auto mode unavailable for this model` | 官方 |
| psmux `send-keys -l` 多行 | 换行被当 Enter 提交。多行内容写文件后用 `Copy-Item` 交给子进程 | 实测（未查到权威文档） |

## 9. 父 agent 使用纪律

凡派出子 agent（`Agent tool` / `codex-companion task` / 任何后台任务），必须在收到"已启动"通知时立即建 waiter 或记录 task ID，不允许派出就忘。Agent completion 通知 ≠ 孙进程完成（详见第 8 节 Codex 一行），须主动 poll status 或在用户问询前确认结果。

### Codex waiter 参考模板

```powershell
$codex = "$env:USERPROFILE/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs"
$taskId = 'task-XXXXXX-YYYY'  # 替换为实际 ID
do {
  Start-Sleep -Seconds 15
  $s = (node $codex status $taskId 2>&1) -join "`n"
} until ($s -match 'Phase: (done|failed|cancelled)')
node $codex result $taskId
```
用 `run_in_background: true` 启动。

## 10. 子命令

`launch_child.js` 以首位 positional arg 为 subcommand。

### `launch`
```
node launch_child.js launch --runtime {claude|codex} --session NAME --model X
```
顺序：psmux 同名检测 → 清 stale tombstone → 原子写 registry（tmp+rename）→ `psmux new-session -- pwsh -NoProfile -Command "..."` 一步启动子进程，env 经 spawnSync env 选项传入（ANTHROPIC_* 只对 claude 分支暴露，codex 分支删掉）。同名 psmux session 已存在时拒绝并提示 `register`。Registry 先于子进程落盘，watcher 从第一个 signal 起就能匹配。**无 send-keys，无 session-env 磁盘文件**。

### `kill`
```
node launch_child.js kill --session NAME
```
顺序：写 tombstone → psmux kill-session →（成功时）删 registry。kill-session 失败时保留 registry（防止活 session 变 orphan），tombstone 已确保 watcher 丢弃该 session 的 signal。

### `list`
```
node launch_child.js list
```
输出所有 registry 条目的 JSON 数组，每条加 `alive` 字段（psmux ls 校验）。

### `status`
```
node launch_child.js status --session NAME
```
输出 registry 元数据 + `alive` + `last_event_state` / `last_event_at`（从 signal 文件取最新）。

### `send`
```
node launch_child.js send --session NAME --text "..."
```
send-keys 文本 + runtime 对应的 submit key（claude→Enter，codex→C-m）。父 agent 负责串行化，两步（send-keys -l + submit key）之间不能被并发 send 插入。

### `register`
```
node launch_child.js register --session NAME --runtime {claude|codex} [--model M] [--pid N] [--parent P] [--force]
```
为已存在的 psmux session 补写 registry（遗留/手建 session）。校验 session 在 psmux 中存活、registry 不存在（`--force` 覆盖）。registry 中标记 `registered: true`。

### Registry schema

**`sessions/{session}.json`**：`{ session, runtime, model, pid, signal_dir, passthrough, started_at }`（launch 创建）/ `{ ..., registered: true }`（register 补建）

**`sessions/{session}.tombstone.json`**：`{ session, killed_at, reason }`

Tombstone 优先：kill 时先写 tombstone 再 kill-session，watcher 看到 tombstone 即丢弃该 session 的 signal（即使 registry 仍存在）。

## 11. 遗留 / 手建 session 补注册

子 session 必须经 `launch_child.js launch` 创建，或先调 `register` 子命令补 registry，
否则 watcher 丢弃所有该 session 的 signal，父静默失效。

补注册：
    node launch_child.js register --session NAME --runtime claude|codex

launch 检测到同名 psmux session 存在（未经框架创建）会直接拒绝并提示用 register。
