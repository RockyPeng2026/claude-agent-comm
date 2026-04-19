# Codex runtime 接入父子通信框架 — 施工 Spec

## 目标
`launch_child.js --runtime codex` 起 psmux 子 codex session → codex `notify` hook → `codex_hook_bridge.js` 翻译成 signal 文件 → 复用现有 watcher → 父 Opus 收到 `stop` 事件。

## 现有协议（不动）
- signal 格式：`{UTC-timestamp}__{state}__{pid}__{guid8}.signal`
- state 值：`permission` / `stop` / `stop_failure`
- `child_signal.js` 接口：`node child_signal.js --state <state>`（不变）
- `watch_child_stream.js` 接口：不变
- 环境变量：`CLAUDE_CHILD_HOOKS=1` + `CLAUDE_CHILD_SIGNAL_DIR` + `CLAUDE_PROJECT_DIR`（codex 分支全部沿用）

## Windows 限制（接受现状）
- Codex CLI hooks（PreToolUse/Stop/etc）在 Windows **官方禁用**，只能用 `notify`
- Codex `notify` 无 permission 事件（issue #6024）→ codex 子不发 `permission` 信号
- Codex `notify` 无 failure 事件 → 由 launcher 在 psmux 命令链尾兜底发 `stop_failure`

## Step 1: 写 `.claude/hooks/codex_hook_bridge.js`

等价逻辑：
- Codex 调 bridge 时把 event JSON 放在 `process.argv[2]`（不是 stdin）
- 兼容两种来源：优先 `argv[2]`，空则读 stdin
- `JSON.parse` 失败 → `exit 0`（bridge 失败不能卡 codex）
- 映射：`type === 'agent-turn-complete'` → state=`stop`；其他 → `exit 0`
- 调 `child_signal.js --state stop`（用 `spawnSync(process.execPath, [script, '--state', state], { env: process.env })`）
- 透传 exit code（默认 0）

示例：
```js
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const raw = process.argv[2] || fs.readFileSync(0, 'utf8');
let evt;
try { evt = JSON.parse(raw); } catch { process.exit(0); }

const state = evt.type === 'agent-turn-complete' ? 'stop' : null;
if (!state) process.exit(0);

const script = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'hooks', 'child_signal.js');
const r = spawnSync(process.execPath, [script, '--state', state], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 0);
```

## Step 2: 写 `D:/English/.codex/config.toml`（项目级 codex 配置）

```toml
notify = ["node", "D:\\English\\.claude\\hooks\\codex_hook_bridge.js"]
```

不写 `[features] codex_hooks` — Windows 禁用，写了也无效。
注意双反斜杠（TOML 字符串转义）。

## Step 3: 改 `.claude/comm/launch_child.js` 加 `--runtime` 分支

新增 CLI 参数 `--runtime {claude|codex}`，默认 `claude`。
- 缺值或下一 token 以 `--` 开头 → stderr + exit 1
- 其他值（非 claude/codex）→ stderr + exit 1

### claude 分支
现有逻辑**完全不变**。

### codex 分支
差异点：
1. **psmux 命令链**：
   ```
   $env:CLAUDE_CHILD_HOOKS='1'; $env:CLAUDE_CHILD_SIGNAL_DIR=<esc>; $env:CLAUDE_PROJECT_DIR=<esc>;
   codex [passthrough...]
   if ($LASTEXITCODE -ne 0) { node <esc: bridge 绝对路径> --state stop_failure }
   ```
   - 不注入 `ANTHROPIC_*`（codex 用自己的凭证：ChatGPT OAuth）
   - 不加 `--dangerously-skip-permissions`（codex 参数不同，透传 passthrough 即可）
   - `--model` 参数也透传（codex CLI 自己解析）
2. **前置检查**：codex 分支不要求 ANTHROPIC_* env
3. **其他**：psmux `new-session` / `send-keys` / 孤儿清理 / JSON 输出逻辑**不变**

### JSON 输出统一
两个分支都输出：
```json
{"session": "<name>", "runtime": "<claude|codex>", "model": "<model 或 default>", "attach_cmd": "psmux attach -t <name>"}
```
claude 分支加 `runtime: "claude"` 字段。

## Step 4: 自测

### Test 1: claude 分支回归
```powershell
$env:ANTHROPIC_AUTH_TOKEN='fake'; $env:ANTHROPIC_BASE_URL='fake'; $env:API_TIMEOUT_MS='1000'
node D:/English/.claude/comm/launch_child.js --runtime claude --session test-claude-regress
# 期望：JSON 含 runtime:"claude"，psmux session 存在，capture-pane 能看到 claude 命令
psmux kill-session -t test-claude-regress
```

### Test 2: codex 分支启动
```powershell
Remove-Item Env:\ANTHROPIC_AUTH_TOKEN,Env:\ANTHROPIC_BASE_URL,Env:\API_TIMEOUT_MS -ErrorAction SilentlyContinue
node D:/English/.claude/comm/launch_child.js --runtime codex --session test-codex
# 期望：JSON 含 runtime:"codex"，psmux session 存在
psmux capture-pane -t test-codex -p | Select-Object -Last 10
# 期望：看到 $env:CLAUDE_PROJECT_DIR=...; codex ... 命令行
```

### Test 3: bridge 单元测试
```powershell
$env:CLAUDE_PROJECT_DIR='D:\English'
$env:CLAUDE_CHILD_HOOKS='1'
$env:CLAUDE_CHILD_SIGNAL_DIR='D:\English\.claude\signals\child-events'
node D:/English/.claude/hooks/codex_hook_bridge.js '{"type":"agent-turn-complete","turn-id":"t1"}'
# 期望：.claude/signals/child-events/ 下新增一个 __stop__ 的 .signal 文件
ls D:/English/.claude/signals/child-events/
```

### Test 4: 参数验证
```powershell
node D:/English/.claude/comm/launch_child.js --runtime bogus
# 期望：stderr + exit 1

node D:/English/.claude/comm/launch_child.js --runtime
# 期望：stderr + exit 1
```

## 禁止
- 不改 `child_signal.js` / `watch_child_stream.js` 接口
- 不引 npm 依赖（只用 Node 内置）
- 不写 `.codex/hooks.json`（Windows 禁用）
- 不在 codex 分支注入 ANTHROPIC_* env
- 不动 Anki 相关代码

## 报告

完成后报告：
- 3 个文件大小（`codex_hook_bridge.js` / `.codex/config.toml` / 改后的 `launch_child.js`）
- Test 1-4 的命令输出
- 确认 `ls .claude/signals/child-events/` 在 Test 3 后有新 signal 文件
