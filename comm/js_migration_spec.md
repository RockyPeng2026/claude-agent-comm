# JS 迁移规格（Round 2）

## 背景
GLM 已完成 hooks 迁 JS（Round 1）：
- ✅ `.claude/hooks/child_signal.js` 写好
- ✅ `.claude/hooks/watch_child_stream.js` 写好
- ✅ `.claude/settings.local.json` hooks 段改 `node ...`
- ✅ `.claude/hooks/CLAUDE.md` 内容更新（父级 agent 已挪到 `.claude/comm/CLAUDE.md`）
- ❌ 旧 `.ps1` 还没删（上轮被父中断）

本轮补 3 件事：
1. `launch_child.py` → `launch_child.js`（位置 `.claude/comm/`）
2. 删旧 `.ps1`（2 个）和旧 `.py`（1 个）
3. 自测

## Step 1: 写 .claude/comm/launch_child.js

等价逻辑（参照 `.claude/comm/launch_child.py`）：

- CLI 参数：
  - `--model <name>`，默认 `glm-5.1`
  - `--session <name>`，默认 `child-${Math.floor(Date.now()/1000)}`
  - 其他 unknown args 透传给 claude（收集到 `passthrough` 数组）
- 必需 env（任一缺失 → stderr + `exit 1`）：
  - `ANTHROPIC_AUTH_TOKEN`
  - `ANTHROPIC_BASE_URL`
  - `API_TIMEOUT_MS`
- 项目根：`PROJECT = path.resolve(__dirname, '..', '..')`（`.claude/comm/launch_child.js` → 向上两级）
- PowerShell 单引号转义函数 `esc(s)`：等价 Python 的 `return "'" + s.replace("'", "''") + "'"`
- 创建 detached psmux session：
  ```
  child_process.spawnSync('psmux', ['new-session', '-d', '-s', sessionName], { stdio: 'inherit' })
  ```
  非 0 退出 → throw（让默认异常消息打出来）
- 构造 PowerShell 命令行（一整行，分号分隔）：
  ```
  $env:CLAUDE_CHILD_HOOKS='1'; $env:CLAUDE_CHILD_SIGNAL_DIR=<esc>; $env:CLAUDE_PROJECT_DIR=<esc>; $env:ANTHROPIC_AUTH_TOKEN=<esc>; $env:ANTHROPIC_BASE_URL=<esc>; $env:API_TIMEOUT_MS=<esc>; claude --model <esc> --dangerously-skip-permissions [passthrough...]
  ```
  - `CLAUDE_CHILD_SIGNAL_DIR` 值：`path.join(PROJECT, '.claude', 'signals', 'child-events')`
  - `CLAUDE_PROJECT_DIR` 值：`PROJECT`
  - 3 个 ANTHROPIC/API 值：从 `process.env` 读
- 发命令：
  ```
  spawnSync('psmux', ['send-keys', '-t', sessionName, '-l', cmdLine], { stdio: 'inherit' })
  spawnSync('psmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'inherit' })
  ```
- 异常处理：如果 send-keys 任一步失败（非 0 退出），调 `spawnSync('psmux', ['kill-session', '-t', sessionName])` 清理孤儿 session，然后 throw
- 输出：
  ```js
  console.log(JSON.stringify({ session: sessionName, model, attach_cmd: `psmux attach -t ${sessionName}` }))
  ```

## Step 2: 删旧文件

```
rm D:/English/.claude/hooks/child_signal.ps1
rm D:/English/.claude/hooks/watch_child_stream.ps1
rm D:/English/.claude/comm/launch_child.py
```

## Step 3: 自测 launch_child.js

```powershell
$env:ANTHROPIC_AUTH_TOKEN='fake'
$env:ANTHROPIC_BASE_URL='fake'
$env:API_TIMEOUT_MS='1000'
node D:/English/.claude/comm/launch_child.js --session test-js-launch
# 期望 stdout: {"session":"test-js-launch","model":"glm-5.1","attach_cmd":"psmux attach -t test-js-launch"}
psmux ls  # 应看到 test-js-launch
psmux capture-pane -t test-js-launch -p | Select-Object -Last 5
# 应看到 $env:CLAUDE_CHILD_HOOKS='1'; ... claude --model 'glm-5.1' ...
psmux kill-session -t test-js-launch  # 清理
```

## Step 4: 缺 env 自测

```powershell
Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
node D:/English/.claude/comm/launch_child.js
# 期望 exit 1 + stderr 含 "missing env"
```

## 禁止

- 不要引 npm 依赖（只用 Node 内置：path, fs, child_process）
- 不要 TypeScript，CommonJS `.js`
- 不要包装 class，顶层脚本
- 不要改 hooks/ 下已写好的 `child_signal.js` / `watch_child_stream.js`
- 不要改 settings.local.json（上轮已改好）
- 不要改 `.claude/comm/CLAUDE.md`（父 agent 会自己更新路径）

## 报告

完成后给：
- `launch_child.js` 文件大小
- Step 3 `psmux capture-pane` 最后 5 行
- Step 4 stderr 输出
- 确认 3 个旧文件都删了（`ls .claude/hooks/` 和 `ls .claude/comm/`）
