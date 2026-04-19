---
name: agent-comm
description: Use this skill when user wants to spawn a child Claude/Codex agent via psmux to delegate work, dispatch prompts, and collect results event-driven. Triggers on phrases like "派子 agent", "起一个 codex session", "launch child claude", "send to child", "dispatch task to GLM/codex", or when framework's launch_child.js / subcommands are mentioned.
---

# Agent Comm — 操作指南

你是**父 agent**。本插件提供 `launch_child.js` 和配套 hook 脚本，让你把工作派给子 Claude / Codex CLI（跑在 psmux session 里），**事件驱动拿结果**，不要轮询。

## 核心原则

1. **父零轮询**。所有子状态通过 hook → signal 文件 → Monitor 主动推送给你。绝不用 `Start-Sleep + capture-pane` 循环查子进度
2. **signal 文件是事件流**。子每个 hook（permission/stop/stop_failure/notification）写一个文件到 `.claude/signals/child-events/`，watcher emit 到 stdout → Monitor → 你收到 task-notification
3. **registry 是 session 真相源**。`.claude/signals/sessions/{name}.json` 每个活 session 一份；kill 写 tombstone

## 前置检查

父 agent 任何动作前确认：
- Monitor 已挂 watcher：`Monitor { command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/watch_child_stream.js --signalDir <project>/.claude/signals/child-events" }`（persistent 模式；`<project>` 是**父 agent 所在项目**的绝对路径）
- `.env` 已 source 到环境（对 claude runtime 必需：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `API_TIMEOUT_MS`）

## 子命令一览

```bash
LAUNCHER="${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js"   # 仅在 plugin 模式下如此；如用 install.js 装到目标项目则是 $CLAUDE_PROJECT_DIR/.claude/comm/launch_child.js

# 起子（psmux 创建 + registry 写 + env 注入 + cmd 构造）
node $LAUNCHER launch \
  --runtime {claude|codex} --model MODEL [--session NAME] [其他 passthrough...]

# 发 prompt（自动按 runtime 选 submit key：claude=Enter, codex=C-m）
node ${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js send --session NAME --text "prompt"

# 查状态（registry + 最新 signal）
node ${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js status --session NAME

# 列活子
node ${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js list

# 结束（先 tombstone 再 psmux kill 再删 registry）
node ${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js kill --session NAME

# 给已有 psmux session 补 registry（遗留/手建的）
node ${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js register \
  --session NAME --runtime {claude|codex} [--model M] [--force]
```

## 典型派工 pattern

```
1. launch → 得到 {session} JSON
2. send --text "..." → prompt 发到子
3. **等**  Monitor 推来 __{session}__stop__ signal（不要 poll）
4. 收到 stop 后：psmux capture-pane -t {session} -p 取输出
5. 继续 send 下条 或 kill 结束
```

## 事件 state 含义

| state | 含义 | 父动作 |
|-------|------|--------|
| `permission` | 子弹权限对话框 | `psmux send-keys -t NAME "1"; Enter` 批（如需） |
| `notification` | 子需要你注意（AskUserQuestion / 长 idle 等） | 看 capture-pane 决定回应 |
| `stop` | 子 turn 完成，等你发新 prompt | 取结果或派下条 |
| `stop_failure` | 子异常退出 | 调查 psmux 状态，kill 清理 |

## 禁做

- **不要** `while (!stopped) sleep(5)` 轮询。违反"父零轮询"。用 Monitor
- **不要**跳过 launch 直接对已存在 psmux `send-keys`。必须有 registry
- **不要**编辑 signal 文件。watcher 会秒删
- **不要**两个父并发 watch 同一 signal 目录（emit+delete 假设单消费者）
- **不要**在子 session 里直接 `attach` 交互（除非 debug）— 你用 send/status/kill 指挥

## 常见坑

- **Tombstone 污染**：kill 后再 launch 同名 → watcher 扔掉新 signal。先 `launch --session NEW_NAME` 或 register 前清 tombstone
- **Legacy session**：手工 psmux 起的 claude/codex 没注册过 → hook 没 env → 永远不 emit signal。要通过 `launch` 起，或只为注册用 `register`（但 hook 仍不会 fire，除非原进程用我们的 env 启动）
- **Codex submit race**：send 子命令已内置 200ms buffer flush。如果偶发 prompt 不提交，手动补 `psmux send-keys -t NAME C-m`
- **Send 的 --text 不能含裸 `--` 开头的 token**：会被 arg parser 吞。用 `--text=--foo` 或包在引号里

## runtime 差异

| 项 | claude | codex |
|------|------|------|
| submit key | Enter | C-m |
| 权限绕过 flag（已内置） | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| 必需 env | ANTHROPIC_AUTH_TOKEN / BASE_URL / API_TIMEOUT_MS | 无（codex 走自己的 ChatGPT OAuth） |
| notify 事件 | 4 种 hook（permission/notification/stop/stop_failure） | 只 `agent-turn-complete` → `stop`，无 permission/failure |
| 结果提取 | pane 启发式 `●...❯` | 可加 `--output-last-message FILE` 原生写结果 |

## 最小示例

```
# 父 agent 任务：让 GLM 子 review 一个文件

1. Monitor start  → pipe watcher stdout
2. launch --runtime claude --session review1 --model glm-5.1 → {session:"review1"}
3. send --session review1 --text "review D:/foo/bar.py，给 PASS/FAIL + 100 字" 
4. [等 Monitor 推 __review1__stop__]
5. psmux capture-pane -t review1 -p  → 拿 review 结果
6. kill --session review1
```

## 发现问题

跑不起来时先查（顺序）：
1. Monitor 是否活着？（有 task_id）
2. `ls .claude/signals/sessions/` registry 有没有 session？
3. `ls .claude/signals/sessions/<name>.tombstone.json` 有没有 stale tombstone？
4. `psmux ls` session 活没活？
5. `psmux capture-pane -t NAME -p` 子在什么状态（idle / working / error）？
