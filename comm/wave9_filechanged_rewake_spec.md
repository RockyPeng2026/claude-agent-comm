# Wave 9 — 真正的事件驱动父 Claude：FileChanged + asyncRewake

## 背景

Wave 8 暴露 gap：Claude Code Monitor 工具**不唤醒 idle agent**，只在 agent 活动 turn 里投递事件。codex 调查 + claude-code-guide 验证：

- `FileChanged` hook event ✅ 存在（v2.1.113）
- `asyncRewake: true` ✅ 存在（hook 可后台运行，`exit 2` 时 stderr 注入父 agent 作为 system-reminder，唤醒 idle agent）
- 文档：[code.claude.com/docs/en/hooks.md](https://code.claude.com/docs/en/hooks.md)

方案：父 Claude launch → 调 `launch_child.js notify`（detached worker）→ end turn。Worker 在后台 wait(child) + collect(child) + 把结果追加到 `deliveries.jsonl`。FileChanged 监听该 JSONL 触发 `rewake_delivery.js`，exit 2 + stderr 携带 result → 父 Claude 被唤醒读到结果贴给用户。

## 目标

1. 用户 `/agent-comm:run-*` 秒回，继续聊天不卡
2. child 完成 → 父 Claude **零用户动作**被唤醒、贴结果
3. 复用 wave8 的 cmdLaunch / cmdWait / cmdCollect，不破坏它们

## 非目标

- 不做 parent session ID 匹配（MVP 假设单父；多父场景 wave 10 再说）
- 不改 `child_signal.js` / `codex_hook_bridge.js` / watch_child_stream.js
- 不动 README

## 文件清单

| 动作 | 文件 |
|------|------|
| 改 | `comm/launch_child.js`（加 `notify` subcommand） |
| 新建 | `hooks/notify_worker.js`（detached worker：wait+collect+append） |
| 新建 | `hooks/rewake_delivery.js`（FileChanged hook body） |
| 改 | `hooks/hooks.json`（加 FileChanged 条目） |
| 改 | `commands/run-codex.md` / `run-claude.md` / `run.md`（删 Monitor 步骤，改调 notify） |

## 精确改动

### 改动 A — 新建 `hooks/notify_worker.js`

```js
// hooks/notify_worker.js — detached: wait(child) → collect(child) → append delivery.
// 用法: node notify_worker.js --session CHILD_SESSION [--timeout-ms N]
// 写一行 JSON 到 $PROJECT/.claude/signals/agent-comm-deliveries.jsonl:
//   { ts, child_session, final_state, result_excerpt, out_file }
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
let childSession = null;
let timeoutMs = 900000; // 15 min
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session') childSession = args[++i];
  else if (args[i] === '--timeout-ms') timeoutMs = parseInt(args[++i], 10);
}
if (!childSession) { process.stderr.write('notify_worker requires --session\n'); process.exit(1); }

const launcher = path.resolve(__dirname, '..', 'comm', 'launch_child.js');
const nodeBin = process.execPath;

// 1) wait
const waitRes = spawnSync(nodeBin, [launcher, 'wait', '--session', childSession, '--timeout-ms', String(timeoutMs)], { encoding: 'utf8' });
let waitJson = {};
try { waitJson = JSON.parse(waitRes.stdout); } catch {}
const finalState = waitJson.final_state || 'timeout';

// 2) collect (--kill: 清理 psmux session)
const collectRes = spawnSync(nodeBin, [launcher, 'collect', '--session', childSession, '--kill'], { encoding: 'utf8' });
let collectJson = {};
try { collectJson = JSON.parse(collectRes.stdout); } catch {}

// 3) 追加 delivery
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const deliveriesFile = path.join(projectDir, '.claude', 'signals', 'agent-comm-deliveries.jsonl');
fs.mkdirSync(path.dirname(deliveriesFile), { recursive: true });
const entry = {
  ts: new Date().toISOString(),
  child_session: childSession,
  final_state: finalState,
  result_excerpt: collectJson.result_excerpt || '',
  out_file: collectJson.out_file || '',
  runtime: collectJson.runtime || waitJson.runtime || ''
};
fs.appendFileSync(deliveriesFile, JSON.stringify(entry) + '\n');
process.exit(0);
```

### 改动 B — 新建 `hooks/rewake_delivery.js`

```js
// hooks/rewake_delivery.js — FileChanged hook body.
// 被 Claude Code 以 asyncRewake=true 触发。读 deliveries.jsonl 新增行，
// 用 stderr 发 result + exit 2 让父 Claude 把 stderr 当 system-reminder 读取。
// 状态文件: $PROJECT/.claude/signals/.deliveries.read.marker 存已读 offset。
const fs = require('fs');
const path = require('path');

// hook 读 stdin 拿 session / file_path 等元数据（JSON）
let hookInput = '';
try { hookInput = fs.readFileSync(0, 'utf8'); } catch {}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const deliveriesFile = path.join(projectDir, '.claude', 'signals', 'agent-comm-deliveries.jsonl');
const markerFile = path.join(projectDir, '.claude', 'signals', '.deliveries.read.marker');

let consumed = 0;
try { consumed = parseInt(fs.readFileSync(markerFile, 'utf8'), 10) || 0; } catch {}

let content = '';
try { content = fs.readFileSync(deliveriesFile, 'utf8'); } catch { process.exit(0); }
if (content.length <= consumed) process.exit(0);

const newPart = content.slice(consumed);
const newLines = newPart.split('\n').filter(l => l.trim());
if (newLines.length === 0) process.exit(0);

const msgs = [];
for (const line of newLines) {
  try {
    const e = JSON.parse(line);
    msgs.push(`[agent-comm] child ${e.child_session} ${e.final_state}: ${(e.result_excerpt || '').split('\n').slice(0, 10).join(' | ')}`);
  } catch {}
}

fs.writeFileSync(markerFile, String(content.length));
if (msgs.length === 0) process.exit(0);

process.stderr.write(msgs.join('\n') + '\n');
process.exit(2);
```

### 改动 C — `comm/launch_child.js` 加 `notify` subcommand

在 `cmdCollect` 之后、`cmdRun` 之前插入：

```js
// ─── notify (detached worker: wait + collect + append delivery JSONL) ───

function cmdNotify(subArgs) {
  let sessionName = null;
  let timeoutMs = 900000;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session') sessionName = subArgs[++i];
    else if (subArgs[i] === '--timeout-ms') timeoutMs = parseInt(subArgs[++i], 10);
  }
  if (!sessionName) { process.stderr.write('notify requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');

  const worker = path.resolve(__dirname, '..', 'hooks', 'notify_worker.js');
  const nodeBin = process.execPath;
  const { spawn } = require('child_process');
  const child = spawn(
    nodeBin,
    [worker, '--session', sessionName, '--timeout-ms', String(timeoutMs)],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || PROJECT }
    }
  );
  child.unref();
  console.log(JSON.stringify({ notify_armed: true, session: sessionName, pid: child.pid }));
}
```

switch (改动 E 同文件)加一条：

```js
  case 'notify':  cmdNotify(subArgs); break;
```

usage 加一行：

```js
    '  notify    --session NAME [--timeout-ms N]            (detached worker → append deliveries.jsonl)\n' +
```

### 改动 D — `hooks/hooks.json` 加 FileChanged

在 "hooks" 对象里加一条（在 Stop / StopFailure 后都行）：

```json
    "FileChanged": [
      {
        "matcher": "agent-comm-deliveries.jsonl",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/rewake_delivery.js\"",
            "asyncRewake": true,
            "timeout": 10
          }
        ]
      }
    ]
```

其它条目不动。

### 改动 E — 重写 `commands/run-codex.md`

**整个替换**为：

```md
---
description: /agent-comm:run-codex [--model Y] -- PROMPT  (defaults --runtime codex，真事件驱动)
---
你是父 Claude。用户发 `/agent-comm:run-codex $ARGUMENTS`。**不调 subagent，不装 Monitor**。按以下执行：

1. 用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime codex $ARGUMENTS
   ```
   解析 JSON 得 `session`。

2. 用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" notify --session <session>
   ```
   （秒回 JSON `notify_armed:true`）

3. 告诉用户："codex 子 agent 已启动（session=SESSION）。child 完成时会自动推回结果，你可以先干别的。"

4. 结束当前轮次。**不开 Monitor，不 collect，不等。**

5. 等待 FileChanged hook 唤醒：child 完成后 hook 会以 system-reminder 注入一行 `[agent-comm] child SESSION stop: RESULT`。你读到该 reminder 时，把 result 清理后告诉用户。
```

### 改动 F — 重写 `commands/run-claude.md`

**整个替换**为：

```md
---
description: /agent-comm:run-claude [--model Y] -- PROMPT  (defaults --runtime claude，真事件驱动)
---
你是父 Claude。用户发 `/agent-comm:run-claude $ARGUMENTS`。**不调 subagent，不装 Monitor**。按以下执行：

1. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime claude $ARGUMENTS` → 得 session
2. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" notify --session <session>` → notify_armed
3. 告诉用户已启动，end turn
4. 等 FileChanged system-reminder 到达，把结果贴给用户
```

### 改动 G — 重写 `commands/run.md`

**整个替换**为：

```md
---
description: /agent-comm:run [--runtime X] [--model Y] -- PROMPT (真事件驱动)
---
你是父 Claude。用户发 `/agent-comm:run $ARGUMENTS`。**不调 subagent，不装 Monitor**。

1. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch $ARGUMENTS` → session
2. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" notify --session <session>`
3. 告诉用户已启动 end turn
4. 等 FileChanged system-reminder 贴结果
```

## 自测

1. `node --check` 两个新 js + launch_child.js → SYNTAX_OK
2. `node comm/launch_child.js notify --session nonexistent` → 秒回 JSON `notify_armed:true`（有 detached worker；即使 session 不存在也不报错，worker 自己会失败）
3. 端到端：
   ```
   cd D:/projects/claude-agent-comm/test/test13
   rm -f .claude/signals/agent-comm-deliveries.jsonl .claude/signals/.deliveries.read.marker
   node ../../comm/launch_child.js launch --runtime codex --session w9t1 -- 输出字符串 hello-w9
   node ../../comm/launch_child.js notify --session w9t1
   # 等 30s
   cat .claude/signals/agent-comm-deliveries.jsonl
   ```
   预期：JSONL 里一行含 `hello-w9`, `final_state=stop`
4. 手动跑 rewake_delivery.js：
   ```
   CLAUDE_PROJECT_DIR=$(pwd) node ../../hooks/rewake_delivery.js < /dev/null
   echo "exit=$?"
   ```
   预期：stderr 含 `[agent-comm] child w9t1 stop: ...hello-w9...`, exit=2
5. 再跑一次相同 hook → stderr 空（marker 已更新），exit=0

## 同步 + 提交

改完：
```
cp comm/launch_child.js ~/.claude/plugins/cache/agent-comm/agent-comm/0.2.0/comm/
cp -r commands/ ~/.claude/plugins/cache/agent-comm/agent-comm/0.2.0/
cp hooks/notify_worker.js hooks/rewake_delivery.js hooks/hooks.json ~/.claude/plugins/cache/agent-comm/agent-comm/0.2.0/hooks/
```

Commit message：

```
feat(wave9): FileChanged + asyncRewake 事件驱动父 Claude

- 新 hooks/notify_worker.js (detached worker: wait+collect+append deliveries.jsonl)
- 新 hooks/rewake_delivery.js (FileChanged hook: stderr + exit 2 注入父 agent)
- launch_child.js 加 notify subcommand (detached spawn worker)
- commands/run-*.md 改调 launch + notify，不装 Monitor
- hooks/hooks.json 加 FileChanged + asyncRewake 配置

效果：用户 /run-* 秒回继续聊天；child 完成父 Claude 自动被唤醒贴结果，零用户动作。
```
