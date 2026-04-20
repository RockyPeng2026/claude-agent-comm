# Wave 8 — 事件驱动重构：拆 cmdRun + /commands 走 Monitor

## 背景

README 承诺"父 Claude + watcher → Monitor 事件驱动"。实际 `cmdRun` 自己在 Node 进程里轮询 signal + capture-pane + kill，整块同步阻塞；而 `commands/run-*.md` 调 `agent-comm:run-child` subagent，subagent 一次 Bash 等 cmdRun 跑完才返回。父 Claude UI "Beaming..." 卡 40-60s。用户打一条 `/agent-comm:run-*` 指令后必须等到子完成才能继续聊天——违反承诺。

codex 分析（a29b92554514dcc0f）给出拆分方案，本 Wave 实施。

## 目标

1. 用户 `/agent-comm:run-*` 秒回（≤5s），用户可立即继续聊天
2. child 完成时父 Claude 经 Monitor 事件被唤醒，读 result 给用户
3. 保留 `node launch_child.js run` 老同步路径（给脚本/非交互使用）

## 非目标

- 不改 hook / bridge / signal 文件名格式
- 不改 registry JSON schema（仅**增**字段 `out_file`，向后兼容）
- 不改 mux 抽象层
- 不改 README（用户自己改；本 Wave 仅改代码 + commands + agent 文件）

## 文件清单

| 动作 | 文件 |
|------|------|
| 改 | `comm/launch_child.js` |
| 改 | `commands/run.md` |
| 改 | `commands/run-claude.md` |
| 改 | `commands/run-codex.md` |
| 删 | `agents/run-child.md` |
| 删 | `skills/agent-comm-forwarder/SKILL.md`（含整个 `skills/agent-comm-forwarder/` 目录） |
| 不动 | `hooks/*.js`、`hooks/hooks.json`、`skills/agent-comm/` |

## 精确改动

### 改动 A — `comm/launch_child.js` 加 `cmdLaunch` 的 out_file 字段

在 line 354 左右 `regData` 对象（现有）里加 `out_file` 字段。先看当前代码：

```js
  const regPath = sessionPath(sessionName, '.json');
  const regData = {
    session: sessionName, runtime, model,
    pid: process.pid, signal_dir: signalDir,
    passthrough_count: effectivePassthrough.length,
    started_at: new Date().toISOString()
  };
```

在 `regData` 之前加：

```js
  // out_file 默认 sessions/{name}.result.txt；cmdRun 可 override，但 launch 单独调用也要有
  const defaultOutFile = path.join(SESSIONS_DIR, `${sessionName}.result.txt`);
```

把 regData 改为：

```js
  const regData = {
    session: sessionName, runtime, model,
    pid: process.pid, signal_dir: signalDir,
    out_file: defaultOutFile,
    passthrough_count: effectivePassthrough.length,
    started_at: new Date().toISOString()
  };
```

cmdLaunch 最末 `console.log(JSON.stringify(...))` 那行现在是：

```js
  console.log(JSON.stringify({ session: sessionName, runtime, model, attach_cmd: `${MUX} attach -t ${sessionName}` }));
```

改为：

```js
  console.log(JSON.stringify({
    session: sessionName, runtime, model,
    signal_dir: signalDir,
    out_file: defaultOutFile,
    attach_cmd: `${MUX} attach -t ${sessionName}`
  }));
```

**关键**：cmdLaunch **不做**任何 boot marker 等待、fatal 哨兵、capture-pane。就是 new-session 就回。当前代码已经基本如此，只需确认。

### 改动 B — `comm/launch_child.js` 加 `cmdWait` 子命令

在 `cmdRun` 函数之前（约 line 500 上方）插入新函数：

```js
// ─── wait (block until stop/stop_failure signal for a session) ───

async function cmdWait(subArgs) {
  let sessionName = null;
  let timeoutMs = 300000;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session') sessionName = subArgs[++i];
    else if (subArgs[i] === '--timeout-ms') timeoutMs = parseInt(subArgs[++i], 10);
  }
  if (!sessionName) { process.stderr.write('wait requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');

  const reg = readRegistry(sessionName);
  const signalDir = reg.signal_dir || path.join(PROJECT, '.claude', 'signals', 'child-events');

  const startTs = reg.started_at ? reg.started_at.replace(/[-:]/g, '').replace(/\.(\d+)Z/, (_, f) => '.' + f.padEnd(7, '0') + 'Z') : '00000000T000000.0000000Z';
  const deadline = Date.now() + timeoutMs;
  let finalState = null;
  const seen = new Set();
  const events = [];

  while (Date.now() < deadline) {
    try {
      const items = fs.readdirSync(signalDir).filter(f => f.endsWith('.signal'));
      for (const name of items) {
        const parts = name.slice(0, -7).split('__');
        if (parts.length !== 5) continue;
        if (parts[1] !== sessionName) continue;
        if (parts[0] < startTs) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        events.push({ ts: parts[0], state: parts[2] });
        if (parts[2] === 'stop' || parts[2] === 'stop_failure') {
          finalState = parts[2];
        }
      }
    } catch {}
    if (finalState) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const out = {
    session: sessionName,
    final_state: finalState || 'timeout',
    events,
    timed_out: !finalState
  };
  console.log(JSON.stringify(out));
  if (!finalState) process.exit(2);
  if (finalState === 'stop_failure') process.exit(1);
  process.exit(0);
}
```

### 改动 C — `comm/launch_child.js` 加 `cmdCollect` 子命令

在 `cmdWait` 之后插入：

```js
// ─── collect (read result from session via capture-pane, optionally kill) ───

function cmdCollect(subArgs) {
  let sessionName = null;
  let killAfter = false;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session') sessionName = subArgs[++i];
    else if (subArgs[i] === '--kill') killAfter = true;
  }
  if (!sessionName) { process.stderr.write('collect requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');

  const reg = readRegistry(sessionName);
  const outFile = reg.out_file || path.join(SESSIONS_DIR, `${sessionName}.result.txt`);
  const runtime = reg.runtime;

  const cap = muxCapture(sessionName, 500);
  let extractSource = 'pane_full_fallback';
  let result = '';
  if (cap.stdout) {
    if (runtime === 'claude') {
      const lastDotIdx = cap.stdout.lastIndexOf('●');
      if (lastDotIdx !== -1) {
        const after = cap.stdout.slice(lastDotIdx);
        const endIdx = after.indexOf('\n❯');
        result = endIdx !== -1 ? after.slice(0, endIdx).trim() : after.trim();
        extractSource = 'pane_heuristic';
      } else {
        result = cap.stdout.trim();
      }
    } else {
      // codex: 找最后一个 '• ' 段
      const lastBulletIdx = cap.stdout.lastIndexOf('• ');
      if (lastBulletIdx !== -1) {
        const after = cap.stdout.slice(lastBulletIdx);
        const endIdx = after.indexOf('\n›');
        result = endIdx !== -1 ? after.slice(0, endIdx).trim() : after.trim();
        extractSource = 'pane_heuristic';
      } else {
        result = cap.stdout.trim();
      }
    }
  }

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result);
  } catch {}

  const out = {
    session: sessionName,
    runtime,
    out_file: outFile,
    extract_source: extractSource,
    result_excerpt: result.split('\n').slice(0, 40).join('\n')
  };
  console.log(JSON.stringify(out));

  if (killAfter) {
    muxKill(sessionName);
    try { fs.unlinkSync(sessionPath(sessionName, '.json')); } catch {}
  }
}
```

### 改动 D — `comm/launch_child.js` cmdRun 重构为 launch + wait + collect 组合

cmdRun 整个函数（line 500-695 左右）**替换**为：

```js
async function cmdRun(subArgs) {
  let runtime = null, model = null, sessionName = null;
  let outFile = null, eventsFile = null, timeoutMs = 300000, keep = false;
  let prompt = null;

  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (a === '--') { prompt = subArgs.slice(i + 1).join(' '); break; }
    else if (a === '--runtime') runtime = subArgs[++i];
    else if (a === '--model') model = subArgs[++i];
    else if (a === '--session') sessionName = subArgs[++i];
    else if (a === '--out') outFile = subArgs[++i];
    else if (a === '--events-file') eventsFile = subArgs[++i];
    else if (a === '--timeout-ms') timeoutMs = parseInt(subArgs[++i], 10);
    else if (a === '--keep') keep = true;
  }

  if (!runtime || (runtime !== 'claude' && runtime !== 'codex')) {
    process.stderr.write('run requires --runtime {claude|codex}\n'); process.exit(1);
  }
  if (!model) model = defaultModelForRuntime(runtime);
  if (!prompt || !prompt.trim()) { process.stderr.write('run requires PROMPT after --\n'); process.exit(1); }

  if (!sessionName) {
    const hex = require('crypto').randomBytes(2).toString('hex');
    sessionName = `run-${Math.floor(Date.now() / 1000)}-${hex}`;
  }
  assertValidSessionName(sessionName, '--session');

  const self = process.argv[1];
  const nodeBin = process.execPath;
  function runSelf(args) {
    return spawnSync(nodeBin, [self, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  }

  // Step 1: launch（秒回）
  const launchRes = runSelf(['launch', '--runtime', runtime, '--model', model, '--session', sessionName, '--prompt', prompt]);
  if (launchRes.status !== 0) {
    process.stderr.write('run: launch failed\n'); process.exit(1);
  }
  let launchJson;
  try { launchJson = JSON.parse(launchRes.stdout); } catch { process.stderr.write('run: launch stdout not JSON\n'); process.exit(1); }
  if (outFile) {
    // 若调用方指定 --out，override registry 里的默认
    const regPath = sessionPath(sessionName, '.json');
    try {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      reg.out_file = outFile;
      atomicWrite(regPath, reg);
    } catch {}
  }

  // Step 2: wait（阻塞等 stop/stop_failure）
  const waitRes = runSelf(['wait', '--session', sessionName, '--timeout-ms', String(timeoutMs)]);
  let waitJson = {};
  try { waitJson = JSON.parse(waitRes.stdout); } catch {}
  const finalState = waitJson.final_state || 'timeout';
  const events = waitJson.events || [];

  // Step 3: collect（读 result，按 keep 决定是否 kill）
  const collectArgs = ['collect', '--session', sessionName];
  if (!keep) collectArgs.push('--kill');
  const collectRes = runSelf(collectArgs);
  let collectJson = {};
  try { collectJson = JSON.parse(collectRes.stdout); } catch {}

  if (eventsFile) {
    try {
      const tmp = `${eventsFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, events.map(e => JSON.stringify(e)).join('\n') + '\n');
      fs.renameSync(tmp, eventsFile);
    } catch {}
  }

  const out = {
    session: sessionName,
    runtime,
    model,
    final_state: finalState,
    timed_out: finalState === 'timeout',
    killed: !keep,
    out_file: collectJson.out_file || launchJson.out_file,
    extract_source: collectJson.extract_source,
    duration_ms: Date.now() - Date.parse(launchJson.started_at || new Date().toISOString()),
    events_count: events.length
  };
  console.log(JSON.stringify(out));

  if (finalState === 'timeout') process.exit(2);
  if (finalState === 'stop_failure') process.exit(1);
  process.exit(0);
}
```

### 改动 E — `comm/launch_child.js` dispatcher + usage

`usage()` 函数（约 line 63-76）加两行：

```js
    '  wait      --session NAME [--timeout-ms N]            (阻塞到 stop 事件)\n' +
    '  collect   --session NAME [--kill]                    (读 result，可选 kill)\n' +
```

放在 `run` 那行上方。

switch（line 703-712）加两条：

```js
  case 'wait':    cmdWait(subArgs).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); }); break;
  case 'collect': cmdCollect(subArgs); break;
```

### 改动 F — `commands/run-codex.md` 重写

**整个文件替换**为：

```md
---
description: /agent-comm:run-codex [--model Y] -- PROMPT  (defaults --runtime codex，事件驱动非阻塞)
---
你是父 Claude。用户发来 `/agent-comm:run-codex $ARGUMENTS`。**不要调用 subagent**。按下列步骤执行：

1. 用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime codex --prompt "$ARGUMENTS"
   ```
   解析 JSON 输出得到 `session`、`signal_dir`、`out_file`。

2. 用 Monitor 工具（persistent: true，timeout_ms: 1800000）启动信号流：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/hooks/watch_child_stream.js" --signalDir <signal_dir>
   ```
   description 填 `child signal stream for <session>`。

3. 告诉用户："codex 子 agent 已启动（session=SESSION）。等完成事件时会自动出结果，你可以先干别的。"

4. 结束当前轮次（不做 Bash collect、不等 wait、不 sleep）。

5. 后续当 Monitor 事件到来（stdout 行含 `__stop__` 或 `__stop_failure__`）：
   - 用 Bash 运行：
     ```
     node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" collect --session <session> --kill
     ```
   - 把 `result_excerpt` 贴给用户，告知 `final_state`。
   - 可选：调 PushNotification 通知用户完成。
   - 调 TaskStop 停掉本 session 的 Monitor。

如果用户同一轮又发新的 `/agent-comm:run-*`，对每个新 session 重复 1-4（多个 Monitor 可以并存）。
```

### 改动 G — `commands/run-claude.md` 重写

**整个文件替换**为：

```md
---
description: /agent-comm:run-claude [--model Y] -- PROMPT  (defaults --runtime claude，事件驱动非阻塞)
---
你是父 Claude。用户发来 `/agent-comm:run-claude $ARGUMENTS`。**不要调用 subagent**。按下列步骤执行：

1. 用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime claude --prompt "$ARGUMENTS"
   ```
   （如果 $ARGUMENTS 里包含 `--model X`，解析 X 并加到 launch 命令，例如 `--model X`；其余参数原样转 passthrough。）
   解析 JSON 输出得到 `session`、`signal_dir`、`out_file`。

2-5. 同 `run-codex.md` 的 2-5 步。
```

### 改动 H — `commands/run.md` 重写

**整个文件替换**为：

```md
---
description: /agent-comm:run [--runtime X] [--model Y] -- PROMPT  (事件驱动非阻塞)
---
你是父 Claude。用户发来 `/agent-comm:run $ARGUMENTS`。**不要调用 subagent**。按下列步骤执行：

1. 从 $ARGUMENTS 解析 `--runtime`、`--model`，其余给 launch 作为 passthrough + prompt。
   用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch <parsed args>
   ```
   解析 JSON 输出得到 `session`、`signal_dir`、`out_file`。

2-5. 同 `run-codex.md` 的 2-5 步。
```

### 改动 I — 删除 `agents/run-child.md`

直接 `rm agents/run-child.md`。

### 改动 J — 删除 `skills/agent-comm-forwarder/` 目录

```
rm -rf skills/agent-comm-forwarder
```

## 自测场景

1. `node --check comm/launch_child.js` → SYNTAX_OK
2. `node comm/launch_child.js` → usage 包含 `wait` 和 `collect` 两行，exit 1
3. `node comm/launch_child.js launch --runtime codex --prompt 'echo hi' --session wave8t1` → **≤2s 返回** JSON 含 `session`、`signal_dir`、`out_file`；随后 `psmux ls | grep wave8t1` 能看到 session 活着。贴实际耗时（用 `time`）
4. 上面 session 等 20s 让 codex 完成，然后 `node comm/launch_child.js wait --session wave8t1 --timeout-ms 60000` → JSON `final_state="stop"`，exit 0
5. 接着 `node comm/launch_child.js collect --session wave8t1 --kill` → JSON 含 `result_excerpt` 非空，psmux 里 wave8t1 被 kill
6. `node comm/launch_child.js run --runtime codex -- 输出字符串 hello-wave8` → legacy 同步路径 final_state=stop，result 含 `hello-wave8`
7. 所有 wave8t* session 清完（`psmux ls | grep wave8` 应无输出）
8. 报告里确认 agents/run-child.md 和 skills/agent-comm-forwarder/ 已删

## 约束

- 不派子 agent
- Bash 只用来跑自测命令 + rm -rf 删子目录
- 改完要 `cp -r` 到 plugin cache 保持 /agent-comm:* 命令能拿到新版（两个 launch_child 和整个 commands/ 目录都要同步到 `~/.claude/plugins/cache/agent-comm/agent-comm/0.2.0/`；删除的 agents/run-child.md 和 skills/agent-comm-forwarder/ 在 cache 里也要删）
- 不 git commit

## Commit 约定（由主 agent commit）

```
feat(wave8): 事件驱动重构 — cmdLaunch 秒回 + cmdWait/cmdCollect + Monitor 驱动 commands

- launch_child.js: 拆 cmdRun → cmdLaunch(秒回) + cmdWait(阻塞到 stop 事件) + cmdCollect(读 result)
- run 子命令保留，内部改走 launch+wait+collect+kill 组合（legacy 同步兼容）
- commands/run-*.md: 重写，不走 subagent；父 Claude 直接 launch + Monitor 订阅 + 收到 stop 再 collect
- 删 agents/run-child.md 和 skills/agent-comm-forwarder/（不再需要）
- registry 加 out_file 字段
```
