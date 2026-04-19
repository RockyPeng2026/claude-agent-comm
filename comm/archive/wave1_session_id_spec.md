# Wave 1: Signal 协议补 session 段

## 目标
多子并存时，signal 文件能归属到具体 session。新协议：

```
旧: {ts}__{state}__{pid}__{guid8}.signal
新: {ts}__{session}__{state}__{pid}__{guid8}.signal
```

## 约束
- 只动协议 + 注入/解析，不动 registry / lifecycle（那是 Wave 2）
- `CLAUDE_CHILD_SESSION` env 作为数据源，父注入、子 hook 读
- 破坏性变更：老格式 signal 文件直接废弃（signals/ 是 gitignored，无迁移成本）
- watcher stdout 仍输出完整 filename（Opus 端自己解析，协议简单）

## Step 1: 改 `.claude/hooks/child_signal.js`

读 `process.env.CLAUDE_CHILD_SESSION`：
- 空或缺 → stderr 写 `child_signal: CLAUDE_CHILD_SESSION is required (in child mode)` + `exit 0`（不阻断子进程，但记一笔）
- 有值 → 拼到文件名：`${ts}__${session}__${state}__${pid}__${guid8}.signal`

注意：
- session 值里**不能含 `__`**（会破坏分隔）。做简单校验：`if (session.includes('__')) { stderr + exit 0 }`
- 其他逻辑（CLAUDE_CHILD_HOOKS gate / dir resolution / mkdirSync / writeFileSync）不变

## Step 2: 改 `.claude/comm/launch_child.js`

两个 runtime 分支的 cmdLine 都加一行 env 注入：
```
$env:CLAUDE_CHILD_SESSION=${esc(sessionName)};
```

插在 `CLAUDE_CHILD_HOOKS=1` 之后、`CLAUDE_CHILD_SIGNAL_DIR` 之前（语义分组：gate → session id → path → secrets）。

## Step 3: 改 `.claude/hooks/watch_child_stream.js`

**无需改代码**。协议变了但 stdout 只打印 filename（Opus 自己按新格式解析）。

但需要**补一个文件名合法性检查**：过滤非 `.signal` 或少于 5 段的文件（旧格式/不完整文件）直接删掉 + stderr 警告。代码示例（插入在 readdirSync 之后、emit 之前）：

```js
function isValid(name) {
  if (!name.endsWith('.signal')) return false;
  const parts = name.slice(0, -7).split('__');
  return parts.length === 5;  // ts, session, state, pid, guid
}
```

不合法的 unlink + `process.stderr.write(`watcher: skipped invalid ${name}\n`)`。

## Step 4: `codex_hook_bridge.js` 无需改

bridge `spawnSync(child_signal.js, { env: process.env })` 已透传 env，`CLAUDE_CHILD_SESSION` 会自动继承。

## Step 5: 更新 `.claude/comm/CLAUDE.md` 第 5 节事件格式

文件名格式段改成：
```
文件名：`{UTC-timestamp}__{session}__{state}__{pid}__{guid8}.signal`
- session：父注入的 CLAUDE_CHILD_SESSION env（psmux session 名同值）
- 解析：去 `.signal` 后缀 → 按 `__` 分割成 5 段
```

启动要求里加：
```
- CLAUDE_CHILD_SESSION：**必需**。父 launch_child.js 自动注入为 psmux session 名
```

## Step 6: 自测

### Test A: child_signal 注入正常
```powershell
$env:CLAUDE_CHILD_HOOKS='1'
$env:CLAUDE_CHILD_SIGNAL_DIR='D:\English\.claude\signals\child-events'
$env:CLAUDE_CHILD_SESSION='test-wave1'
node D:/English/.claude/hooks/child_signal.js --state stop
# 期望：.signal 文件名格式 {ts}__test-wave1__stop__{pid}__{guid}.signal
ls D:/English/.claude/signals/child-events/ | Select-Object -Last 1
```

### Test B: 缺 session env 安全退出
```powershell
Remove-Item Env:\CLAUDE_CHILD_SESSION -ErrorAction SilentlyContinue
$env:CLAUDE_CHILD_HOOKS='1'
node D:/English/.claude/hooks/child_signal.js --state stop 2>&1
# 期望：stderr 含 "CLAUDE_CHILD_SESSION is required" + exit 0（echo $LASTEXITCODE）
```

### Test C: session 含 `__` 被拒
```powershell
$env:CLAUDE_CHILD_SESSION='bad__name'
node D:/English/.claude/hooks/child_signal.js --state stop 2>&1
# 期望：stderr + exit 0，signal 目录无新文件
```

### Test D: launch_child 注入链
```powershell
$env:ANTHROPIC_AUTH_TOKEN='fake'; $env:ANTHROPIC_BASE_URL='fake'; $env:API_TIMEOUT_MS='1000'
node D:/English/.claude/comm/launch_child.js --runtime claude --session test-wave1-launch
psmux capture-pane -t test-wave1-launch -p -S -10 | Select-Object -Last 3
# 期望：看到 $env:CLAUDE_CHILD_SESSION='test-wave1-launch'
psmux kill-session -t test-wave1-launch
```

### Test E: watcher 过滤坏文件名
```powershell
$dir = 'D:\English\.claude\signals\child-events'
'' | Out-File -Encoding ASCII "$dir\bad-format.signal"   # 不合法文件名
'' | Out-File -Encoding ASCII "$dir\20260419T100000.0000000Z__only4segments__pid.signal"
# 起 watcher（另一个 pwsh 窗口），期望 stderr 有 skipped 警告，两个坏文件都被 unlink
```

## 禁止
- 不改 child_signal.js 的 CLI 参数（仍是 `--state` 单参数）
- 不改 watcher 的 stdout 协议（仍打印完整 filename）
- 不引 npm 依赖
- 不动 registry 相关（Wave 2）
- 不改 ts 格式 / guid 长度

## 报告
完成后给：
- 3 个改动文件大小（child_signal.js / launch_child.js / watch_child_stream.js）
- Test A 生成的 signal 文件名（验证 5 段）
- Test B/C 的 stderr + exit code
- Test D 的 capture-pane 输出（看到 CLAUDE_CHILD_SESSION 行）
- Test E 的 watcher 行为（stderr 警告 + 文件被删）
