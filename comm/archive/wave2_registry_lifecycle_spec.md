# Wave 2: Registry + Lifecycle 子命令

## 目标
- 多子 session 并存时可清点、可清理、可查询、可发 prompt
- 所有 session 元数据落盘（`.claude/signals/sessions/`），父重启能 resume
- watcher 丢弃"无 registry"的孤儿 signal（防止 killed session 的残留事件污染）

## 约束
- 遵循代码/文档质量标准（健壮、精简、稳定、高可用、无错误、无冗余、好维护、可拓展）
- 破坏性改 launch_child.js CLI：从"单动作"变"首位 subcommand"
- registry 是 single source of truth；`psmux ls` 只做校验
- 不动协议（signal 文件名 Wave 1 已定）

## Registry schema

位置：`.claude/signals/sessions/{session}.json`

```json
{
  "session": "hello",
  "runtime": "claude",
  "model": "glm-5.1",
  "pid": 12345,
  "signal_dir": "D:\\English\\.claude\\signals\\child-events",
  "passthrough": [],
  "started_at": "2026-04-19T10:30:00.000Z"
}
```

Tombstone：`.claude/signals/sessions/{session}.tombstone.json`（session kill 后写）

```json
{
  "session": "hello",
  "killed_at": "2026-04-19T10:45:00.000Z",
  "reason": "user kill"
}
```

Registry 和 tombstone 互斥（任一 session 在任一时刻只有一个状态）。

## Step 1: 改 `launch_child.js` — subcommand 架构

第一位 positional arg = subcommand：`launch` / `kill` / `list` / `status` / `send`。

- 无 subcommand 或 subcommand 非法 → stderr usage + exit 1
- 每个 subcommand 独立解析剩余 args
- 共用 `PROJECT` / `esc()` / 路径工具在顶层

### `launch` subcommand（现有 launch_child.js 逻辑 + registry 写入）

参数：`--runtime {claude|codex}`、`--session NAME`、`--model X`、unknown → passthrough。

行为（基本不变，新增最后一步）：
1. 原有 validate + psmux new-session + send-keys 逻辑
2. **新增**：`spawnSync` 成功后，原子写 `.claude/signals/sessions/{session}.json`：
   - 目录不存在先 `mkdirSync(..., { recursive: true })`
   - 写 tmp 文件：`{session}.json.tmp.{pid}`
   - 原子 `renameSync` 到 `{session}.json`
   - 若目标已存在（另一子已占用 session 名）→ `fs.openSync(target, 'wx')` 失败 → 回滚（kill-session + 删 tmp）+ stderr + exit 1
3. 出错任意一步 → 清理已建的 psmux session + tmp 文件
4. 最后打 JSON（原有行为）

### `kill` subcommand

参数：`--session NAME`（必填）。

行为：
1. 读 registry `{session}.json`。不存在 → stderr + exit 1
2. `psmux kill-session -t {session}`（exit 非 0 不阻断，可能已死）
3. 原子写 tombstone `{session}.tombstone.json`（tmp + rename）
4. 删 registry `{session}.json`
5. 打 `{"killed": "NAME"}` JSON

### `list` subcommand

参数：无。

行为：
1. 扫 `.claude/signals/sessions/*.json`（排除 `*.tombstone.json`）
2. `psmux ls` 拿现存 session 名集合
3. 对每个 registry 条目：加字段 `alive: <session 在 psmux ls 里>`
4. 输出 JSON 数组

### `status` subcommand

参数：`--session NAME`（必填）。

行为：
1. 读 registry `{session}.json`
2. 扫 `.claude/signals/child-events/` 里匹配 `*__{session}__*.signal` 的最新文件（按文件名字典序取最大）
3. 取该文件的 `{state}` 和 `{ts}` 段 → `last_event_state` / `last_event_at`（若无则 `null`）
4. `alive = (session 在 psmux ls)`
5. 输出合并 JSON

### `send` subcommand

参数：`--session NAME`（必填）、`--text "..."`（必填）。

行为：
1. 读 registry → 拿 `runtime`
2. `psmux send-keys -t {session} -l {text}`
3. 按 runtime 发 submit key：
   - `claude` → `psmux send-keys -t {session} Enter`
   - `codex` → `psmux send-keys -t {session} C-m`
4. 打 `{"sent": "NAME"}` JSON

## Step 2: watcher 改造 — 孤儿 signal 丢弃

`.claude/hooks/watch_child_stream.js`：

- 启动时记住 `sessionsDir = path.join(dir, '..', 'sessions')`（即 `.claude/signals/sessions/`）
- 每次 tick 扫 signal 文件时，对每个 valid 5 段文件：
  - 从文件名取 session 段
  - 检查 `sessionsDir/{session}.json` 是否存在（同步 `fs.existsSync`）
  - 不存在（或存在 tombstone）→ `unlinkSync` + stderr warning "orphan signal: {name}"，不 emit
  - 存在 → 正常 emit + unlink

## Step 3: 更新 `.claude/comm/CLAUDE.md`

新增 "## 10. 子命令" section，简述每个 subcommand 的用法。

事件格式章节加一句：watcher 丢弃无对应 registry 的 signal。

## Step 4: 自测

### Test A: launch 写 registry
```
node launch_child.js launch --runtime claude --session t1 --model glm-5.1
# 期望：.claude/signals/sessions/t1.json 存在，内容对
cat .claude/signals/sessions/t1.json
```

### Test B: list 看到活子
```
node launch_child.js list
# 期望：JSON 数组含 {session:"t1", alive:true, ...}
```

### Test C: status 看最新事件
```
# 先 send 一个任务触发 stop
node launch_child.js send --session t1 --text "ping test"
# 等 3s
Start-Sleep -Seconds 5
node launch_child.js status --session t1
# 期望：last_event_state 为 "stop"，alive:true
```

### Test D: kill 清理
```
node launch_child.js kill --session t1
# 期望：psmux ls 无 t1，registry 无 t1.json，tombstone 有 t1.tombstone.json
psmux ls
ls .claude/signals/sessions/
```

### Test E: 孤儿 signal 丢弃
```
# 手动造个无对应 registry 的 signal 文件
touch ".claude/signals/child-events/20260419T000000.0000000Z__ghost__stop__99999__deadbeef.signal"
# 起 watcher（另 pwsh 窗口）
node .claude/hooks/watch_child_stream.js --signalDir .claude/signals/child-events
# 期望：stderr 有 "orphan signal: ..."，stdout 不 emit，文件被 unlink
```

### Test F: 重名 session
```
node launch_child.js launch --runtime claude --session t1 --model glm-5.1
node launch_child.js launch --runtime claude --session t1 --model glm-5.1
# 期望：第二次 exit 1，psmux t1 未被第二次触碰
node launch_child.js kill --session t1  # 清理
```

### Test G: send 按 runtime 选 submit key
```
node launch_child.js launch --runtime codex --session tc --model gpt-5.4
node launch_child.js send --session tc --text "echo hi"
# 期望：codex 收到 C-m，开始 Working
node launch_child.js kill --session tc
```

## 禁止
- 不动 signal 协议（Wave 1 已定）
- 不动 child_signal.js（接口不变）
- 不引 npm 依赖
- send-keys 用 spawnSync，不用 shell 拼接
- 不在 kill 里等 stop hook（见 Codex 第 5 点：kill 后 hook 不保证 fire）

## 报告
- 改后文件大小（launch_child.js）
- Test A-G 的命令输出
- 确认目录结构 `.claude/signals/sessions/` 清爽
