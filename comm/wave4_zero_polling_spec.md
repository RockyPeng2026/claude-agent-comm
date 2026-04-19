# Wave 4 — 父 agent 零轮询强化

## 目标
让父 agent 在框架约束、文档、CLI 输出和默认安装路径的共同引导下，**自然进入 watcher + Monitor 驱动的等待模式**，而不是自己写 `sleep` + `status` 轮询。

## 根因矩阵

| ID | 根因 | 当前证据 |
|----|------|----------|
| R1 | `comm/CLAUDE.md` §9 直接给出 `Start-Sleep` waiter 模板，把轮询写成“官方姿势” | `comm/CLAUDE.md:87-102` |
| R2 | 运行时协议没有复述项目根 `CLAUDE.md` 的“父 agent 零轮询”不变式，父只读框架文档时接收不到顶层约束 | `CLAUDE.md:15` vs `comm/CLAUDE.md` 全文 |
| R3 | `comm/CLAUDE.md` §2 把“消费方式”写成“父进程轮询 `$signalDir`”，把 watcher 的内部轮询错误上升成父的职责 | `comm/CLAUDE.md:15-18` |
| R4 | `comm/CLAUDE.md` §4 只给 watcher 启动命令，没有定义 Monitor 如何接 watcher stdout、notification 到来后父该先做什么、`send` 后父该进入什么状态 | `comm/CLAUDE.md:29-41` |
| R5 | 状态表虽有 `permission/notification/stop/stop_failure`，但没有“父动作顺序”协议，导致父容易在收到通知后回退到 `status` 轮询 | `comm/CLAUDE.md:53-59` |
| R6 | 默认安装/首次使用路径不包含 watcher/Monitor 启动步骤，README 也只有一句“见第 4 节”，实际 happy path 不完整 | `install.js:50-59`, `README.md:49-72` |
| R7 | `launch` / `send` 返回体只给最小结果，不给“下一步等待 signal，不要 poll status”的提示，也不暴露 watcher readiness | `comm/launch_child.js:276`, `comm/launch_child.js:375` |
| R8 | `status` 作为公共 API 存在，但文档没有把它降级为“诊断接口”，父 agent 自然会把它当 waiter primitive | `CLAUDE.md:35`, `comm/CLAUDE.md:126-136` |

## 解决方案

### A1 [DOC] 在运行时协议开头复述“父零轮询”不变式
- 对应根因：R2, R3
- 文件：`comm/CLAUDE.md`
- 位置：`## 1. 概述`、`## 2. 协议`
- 改成：

```md
## 1. 概述

这是父子 agent 的运行时协议。**项目级不变式同样适用这里：父 agent 零轮询。**
允许轮询的只有 watcher 内部对 signal 目录的扫描；父 agent 自己不得写 `sleep` + `status` 等待循环。

本框架的标准等待链路：
hook -> signal 文件 -> watcher stdout -> Monitor notification -> 父 agent 被唤醒
```

```md
## 2. 协议

事件源：子进程的 Stop / PermissionRequest / StopFailure / Notification hook。  
事件载体：`$signalDir/{UTC-timestamp}__{session}__{state}__{pid}__{guid8}.signal`（空内容）。  
消费方式：
- watcher 轮询 `$signalDir`，按文件名排序把事件文件名逐行写到 stdout，并删除该文件
- Monitor 订阅 watcher stdout，把每一行转成 task-notification 唤醒父 agent
- 父 agent **只响应 notification**，不直接轮询 `$signalDir`，也不写 `sleep` 循环轮询 `status`
```

### A2 [DOC] 把 watcher + Monitor 机制写成完整的“父等待协议”
- 对应根因：R4, R5
- 文件：`comm/CLAUDE.md`
- 位置：替换 `## 4. 启动要求` 中“父 watcher”小节，并在 `## 5. 事件格式` 后新增 `## 6. 父 agent 事件处理顺序`
- 改成：

```md
### 父 watcher / Monitor

标准做法是让 Claude Code Monitor 启动下面这条长期运行命令：

`node .claude/comm/launch_child.js watch`

兼容低层命令（仍可用，但不再作为文档主路径）：

`node .claude/hooks/watch_child_stream.js --signalDir <project>/.claude/signals/child-events`

机制说明：
1. watcher 每向 stdout 写出一行 signal 文件名，Monitor 就会产生一次 task-notification
2. 父 agent 被唤醒后，优先读取这次 notification 对应的 signal 文件名
3. 父从文件名解析出 `session` 和 `state`，按下方“父 agent 事件处理顺序”动作
4. `status` 只允许做单次诊断，不允许放进等待循环
```

```md
## 6. 父 agent 事件处理顺序

父 agent 在 `launch` / `send` 之后的默认行为：
1. 确认 watcher 已经由 Monitor 托管
2. 进入空闲等待，不写 sleep / poll
3. 收到 Monitor notification 后，读取 watcher 刚输出的 signal 文件名
4. 解析 `session`、`state`
5. 按 state 处理：
   - `permission`：批准或介入
   - `notification`：读取上下文，决定等用户还是继续发 prompt
   - `stop`：子已空闲，可发下一条指令或收尾
   - `stop_failure`：停止自动流转，进入排查
6. 仅当 notification 内容丢失、重复或上下文不足时，才允许单次调用 `status --session NAME` 做诊断

禁止模式：
- `until (...) { Start-Sleep; status }`
- “每 15 秒查一次 status 看 stop 了没”
- send 后立即建后台 waiter 轮询 status
```

### A3 [DOC] 删除主文档中的轮询 waiter 模板，并把它降级为“框架外例外”
- 对应根因：R1
- 文件：`comm/CLAUDE.md`
- 位置：重写 `## 8. 兼容性与已知限制` 中 Codex 一行；完全替换 `## 9. 父 agent 使用纪律`
- 改成：

```md
| Codex 插件后台 task-notification | 某些框架外 codex-companion 背景任务没有 push 通知；这不属于本框架的零轮询等待路径 | 实测 |
```

```md
## 9. 父 agent 使用纪律

- 凡通过本框架管理的子 session，父 agent 必须走 watcher + Monitor 等待链路
- `status` 是诊断接口，不是 waiter
- 若某任务无法接入本框架 signal 协议，应明确标记为“框架外兼容路径”，不得把其轮询模板写成通用参考模板

本框架文档中不再提供 `sleep` + `status` waiter 示例。
如确需兼容框架外任务，另放到 archive/ 或独立兼容文档，并在标题上显式标注“不满足父零轮询不变式”
```

### A4 [DOC] 给 `status` 降级：保留 API，但明确是诊断，不是等待原语
- 对应根因：R5, R8
- 文件：`comm/CLAUDE.md`, `README.md`
- 位置：`comm/CLAUDE.md` 的 `### status`、`### send`；`README.md` 的“使用”
- 改成：

```md
### `status`
`node launch_child.js status --session NAME`

用途：单次诊断 registry / alive / 最近事件。  
非用途：等待 stop；不允许在循环里调用。
```

```md
### `send`
`node launch_child.js send --session NAME --text "..."`

send 完成后，父 agent 的下一步不是 poll `status`，而是回到 watcher + Monitor 等待链路。
```

README 使用示例后补一段：

```md
上面的 `status` 仅用于诊断。正常等待子 agent 完成时，父侧应让 Monitor 托管 `node .claude/comm/launch_child.js watch`，靠 notification 被动唤醒。
```

### A5 [PROTO] 新增 `watch` 子命令，作为 watcher 的规范入口
- 对应根因：R4, R6, R7
- 文件：`comm/launch_child.js`, `comm/CLAUDE.md`, `README.md`
- 位置：`launch_child.js` `usage()`、`main switch`；`comm/CLAUDE.md` §4；`README.md`“使用”
- 改成：

CLI 新签名（新增，向后兼容）：

```text
node launch_child.js watch [--signal-dir DIR] [--poll-ms N]
```

行为草案：
1. `watch` 只是对 `hooks/watch_child_stream.js` 的框架级封装，stdout 协议保持“每行一个 signal 文件名”不变
2. 不改现有 `hooks/watch_child_stream.js` 直接调用方式；`watch` 成为**文档中的唯一首选命令**
3. `watch` 启动时打印一行 stderr：
   `watch: monitoring <dir>; connect this process to Claude Code Monitor`

文档草案：

```md
父侧 canonical 命令：
`node .claude/comm/launch_child.js watch`

低层脚本 `hooks/watch_child_stream.js` 仍保留给调试或兼容场景，不再作为首选示例。
```

### A6 [PROTO] 增加 watcher readiness 心跳文件，供 `launch` / `send` 返回体提示
- 对应根因：R6, R7
- 文件：`hooks/watch_child_stream.js`, `comm/launch_child.js`, `comm/CLAUDE.md`
- 位置：`watch_child_stream.js` 顶部初始化 / `setInterval`；`cmdLaunch` / `cmdSend` 输出；`comm/CLAUDE.md` 新增 “watcher readiness”
- 改成：

新增文件协议（向后兼容）：

```text
.claude/signals/watchers/default.json
```

内容草案：

```json
{
  "signal_dir": "D:\\repo\\.claude\\signals\\child-events",
  "pid": 12345,
  "started_at": "2026-04-19T12:00:00.000Z",
  "updated_at": "2026-04-19T12:00:03.000Z",
  "consumer": "monitor"
}
```

规则草案：
- watcher 启动时创建该文件；每 2 秒刷新 `updated_at`
- `launch` / `send` 读该文件，若不存在或 `updated_at` 超过 10 秒，则视为 `missing`
- 该 readiness 只用于提示，不阻塞既有命令

`comm/CLAUDE.md` 需新增一句：

```md
`launch` / `send` 里的 `watcher` 字段只表示最近是否检测到活跃 watcher 心跳，不等价于 Claude Code Monitor 已正确绑定；它是“高概率可用”提示，不是绝对保证。
```

### A7 [UX] 扩充 `launch` 返回体，显式告诉父“下一步不是 poll”
- 对应根因：R6, R7
- 文件：`comm/launch_child.js`, `comm/CLAUDE.md`
- 位置：`cmdLaunch()` 成功输出 JSON；`comm/CLAUDE.md` `### launch`
- 改成：

返回体草案：

```json
{
  "session": "mywork",
  "runtime": "claude",
  "model": "glm-5.1",
  "attach_cmd": "psmux attach -t mywork",
  "watcher": "ok",
  "watch_cmd": "node .claude/comm/launch_child.js watch",
  "next_step": "use send, then wait for Monitor notification from watcher",
  "zero_polling": true
}
```

若没检测到 watcher 心跳：

```json
{
  "watcher": "missing",
  "watch_cmd": "node .claude/comm/launch_child.js watch",
  "warning": "event-driven waiting requires an active watcher connected to Monitor"
}
```

### A8 [UX] 扩充 `send` 返回体，把“等待 signal”变成机器可读提示
- 对应根因：R5, R7, R8
- 文件：`comm/launch_child.js`, `comm/CLAUDE.md`
- 位置：`cmdSend()` 成功输出 JSON；`comm/CLAUDE.md` `### send`
- 改成：

返回体草案：

```json
{
  "sent": "mywork",
  "await": "signal",
  "expected_states": ["permission", "notification", "stop", "stop_failure"],
  "wake_via": "watcher_stdout -> Monitor notification",
  "watcher": "ok",
  "do_not": "poll status in a loop"
}
```

文档补一句：

```md
`send` 成功返回只表示文本已送入 TTY，不表示子已完成；完成判定只能来自后续 signal 事件。
```

### A9 [UX] 把 watcher/Monitor 启动纳入安装后的默认清单
- 对应根因：R6
- 文件：`install.js`, `README.md`
- 位置：`install.js` 最后的“下一步手动”；`README.md` “安装到目标项目”
- 改成：

`install.js` 输出草案：

```text
=== 完成 ===
下一步手动：
  1. merge ...settings.local.json.example 的 hooks 段到 ...settings.local.json
  2. 启动父侧 watcher（推荐让 Claude Code Monitor 托管）：
     node .claude/comm/launch_child.js watch
  3. Codex 用户 copy 模板：
     cp ".../config.toml.template" "<target>/.codex/config.toml"
  4. 目标项目 .gitignore 加：
     .claude/signals/
```

README 草案：

```md
首次使用检查：
1. hooks 已 merge 到 `.claude/settings.local.json`
2. 父侧已有一个长期运行的 `node .claude/comm/launch_child.js watch`，并由 Monitor 托管
3. 再执行 `launch` / `send`
```

### A10 [DOC] 在 `comm/CLAUDE.md` 放“父首次使用清单”，不再新建 `PARENT_GUIDE`
- 对应根因：R4, R6
- 文件：`comm/CLAUDE.md`, `README.md`
- 位置：`comm/CLAUDE.md` 前部新增 `## 父首次使用清单`；README 保留简版镜像
- 改成：

```md
## 父首次使用清单

在当前 Claude session 第一次使用本框架前，确认：
1. `.claude/settings.local.json` 已接入 `child_signal.js`
2. `node .claude/comm/launch_child.js watch` 正在由 Monitor 托管
3. 你知道 notification 到来后应先读 signal 文件名，再按 state 动作
4. 你不会把 `status` 放进等待循环
```

放在 `comm/CLAUDE.md` 而不是新文件，避免父 agent 只读协议文档时漏掉关键步骤。

## 设计讨论

### § 9 codex-companion waiter 模板怎么处理
结论：**从主协议文档中删除，不保留在一般路径。**

理由：
- 当前 bug 的直接诱因就是它出现在“父 agent 使用纪律”正文里，优先级过高
- 即使保留“例外情况 + 显式限制”，父 agent 也很容易抓到现成模板继续 poll
- Wave 4 的目标是“自然走事件驱动”，不是“保留一个更谨慎的轮询模板”

兼容处理：
- 在 `## 8. 兼容性与已知限制` 只保留一句事实描述：某些框架外 codex-companion 背景任务没有 push 通知
- 若以后真要留轮询模板，单独放 archive/ 或 `compat/`，标题显式写“框架外兼容路径，不满足父零轮询不变式”

### Monitor 协议要不要在框架侧封装成 `launch_child.js watch`
结论：**要，加 `watch` 子命令；但仍由父 agent 主动起，并交给 Monitor 托管。**

权衡：
- 封装的收益是把“正确入口”从裸脚本路径收敛成单一公共 API，减少文档分叉
- 仍然需要父主动起，因为 Claude Code 的 Monitor 绑定动作不可能由普通 Node 子进程代替完成
- 因此最合适的方案不是“框架替父启动 Monitor”，而是“框架提供单一 watch 命令 + readiness 心跳，父仍负责把它接到 Monitor 上”

### `send` 返回加 hint 要加什么字段
结论：加**纯增量字段**，不破坏现有 `{ sent: ... }` 调用方。

建议字段：
- `await: "signal"`
- `expected_states: ["permission", "notification", "stop", "stop_failure"]`
- `wake_via: "watcher_stdout -> Monitor notification"`
- `watcher: "ok" | "missing"`
- `do_not: "poll status in a loop"`

兼容性：
- 全是新增字段，旧调用方忽略即可
- 同样策略适用于 `launch`

### 父首次使用清单放哪
结论：**主版本放 `comm/CLAUDE.md`，README 放简版，不新建 `comm/PARENT_GUIDE.md`。**

理由：
- 运行时父 agent 最可能只读 `comm/CLAUDE.md`
- README 面向人类安装者，适合放简版 checklist
- 新建 `PARENT_GUIDE.md` 会把关键路径拆成三处：README / CLAUDE / GUIDE，后续容易漂移

## 自测场景

1. 新开一个父 Claude session，只读更新后的 `comm/CLAUDE.md`，不看顶层 `CLAUDE.md`，仍能得出“父不能写轮询”的结论。若读完后还能合理推出 `sleep + status`，说明修复失败。
2. 按 README / install 输出首次配置时，用户会先启动 `node .claude/comm/launch_child.js watch` 并让 Monitor 托管，再去 `launch` / `send`。如果 happy path 仍不包含这一步，说明默认体验还有洞。
3. 执行 `launch` 时，若 watcher 未运行，返回体应出现 `watcher: "missing"` 和明确 warning；若 watcher 活着，应出现 `watcher: "ok"`。如果 launch 输出仍像现在一样无提示，说明 UX 未修复。
4. 执行 `send` 后，返回体应明确告诉父“等待 signal，而不是 poll status”。如果返回体仍只有 `{ "sent": "..." }`，说明父的下一步仍无引导。
5. watcher 产生一条 `...__stop__...signal` 并通过 Monitor 唤醒父后，父按照文档顺序先读 signal 文件名、解析 state，再决定继续发 prompt 或收尾。若文档流程仍需要“先去 status 看看”，说明协议仍断裂。
6. 在 `permission` / `notification` / `stop_failure` 三种状态下，父都能根据 `comm/CLAUDE.md` 的动作顺序直接处理，不需要 invent 自己的 waiter。若任一状态缺默认动作，说明状态机还不完整。
7. 全链路日志或父 agent transcript 中，不再出现 `Start-Sleep`、`until (...)`、周期性 `status --session`。如果这些模式仍是文档推荐或 CLI hint 暗示出来的，说明 Wave 4 目标未达成。
8. 低层兼容仍成立：直接运行 `hooks/watch_child_stream.js` 的旧命令仍可工作；新增 `watch` 只是 canonical wrapper。若旧路径被无故破坏，则超出 Wave 4 的向后兼容目标。

## 不做

- 不改现有 signal 文件名格式、registry schema、`launch/kill/list/status/send/register` 已有参数签名
- 不把 watcher 的内部目录扫描从 polling 改成文件系统事件；Wave 4 只约束“父零轮询”，不重写 watcher 实现
- 不处理“框架外 codex-companion 背景任务如何零轮询”这一更大问题；Wave 4 只保证本框架管理的子 session 路径正确
- 不自动替用户创建 Claude Code Monitor 配置；只提供 canonical watch 命令和 readiness 提示
- 不引入多父并发消费同一 signalDir 的新语义
- 不做结果流式 API 或自动 approval 流程增强
- 不新增 `comm/PARENT_GUIDE.md`，避免文档分叉
