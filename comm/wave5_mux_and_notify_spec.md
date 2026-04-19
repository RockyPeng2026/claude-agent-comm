# Wave 5 — mux abstraction + codex notify injection

## 目标

1. **抽象多路复用器**：`psmux`（Windows）/ `tmux`（非 Windows）统一走 `MUX` 常量 + `mux*` 助手，现有所有 `spawnSync('psmux', ...)` 替换为走助手
2. **Bug 1 修复**：`cmdSend` 用 `mux load-buffer + paste-buffer -p + send-keys Enter` 替换 `send-keys -l + sleep + C-m + sleep + C-m` bandaid。跨 runtime（claude/codex）统一走这条路径
3. **Bug 2 修复**：codex runtime 启动时注入 `-c notify=["node","<plugin>/hooks/codex_hook_bridge.js"]`，让 codex 完成 agent-turn 时触发 bridge 写 signal

## 文件

仅改 `D:/projects/claude-agent-comm/comm/launch_child.js`。不动其它文件。

## 精确改动

### 改动 A — 新增 mux 抽象（在 line 18 `esc` 之后插入）

```js
// ─── mux (psmux on Windows, tmux elsewhere) ───
const MUX = process.platform === 'win32' ? 'psmux' : 'tmux';

function muxLs() {
  const r = spawnSync(MUX, ['ls'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return new Set();
  return new Set(r.stdout.trim().split('\n').filter(Boolean).map(l => l.split(':')[0]));
}

function muxKill(session) {
  return spawnSync(MUX, ['kill-session', '-t', session], { stdio: 'inherit' });
}

function muxCapture(session, scrollback) {
  const args = ['capture-pane', '-t', session, '-p'];
  if (scrollback && scrollback > 0) { args.push('-S', `-${scrollback}`); }
  return spawnSync(MUX, args, { encoding: 'utf8' });
}

function muxNewSessionDetached(session, cmd, cmdArgs, env) {
  return spawnSync(
    MUX,
    ['new-session', '-d', '-s', session, '--', cmd, ...cmdArgs],
    { stdio: 'inherit', env }
  );
}

// Paste text via bracketed paste, then submit with a clean Enter.
// 为什么这样稳：
//   - tmux paste-buffer -p 在 pane 处于 MODE_BRACKETPASTE 时发 ESC[200~..ESC[201~
//   - codex TUI 开 EnableBracketedPaste（tui.rs::set_modes），crossterm 把它解析成
//     Event::Paste → handle_paste() 走结构化路径 + clear_after_explicit_paste()
//   - paste_burst 状态清掉后，紧跟的 send-keys Enter 是干净 KeyCode::Enter，直接 submit
//   - claude TUI 同样支持 bracketed paste，统一这条路径不挑 runtime
function muxPasteAndSubmit(session, text) {
  const bufName = `in_${session}`;
  const load = spawnSync(MUX, ['load-buffer', '-b', bufName, '-'], {
    input: text, stdio: ['pipe', 'inherit', 'inherit']
  });
  if (load.status !== 0) return { ok: false, step: 'load-buffer', status: load.status };
  const paste = spawnSync(MUX, ['paste-buffer', '-d', '-p', '-b', bufName, '-t', session], { stdio: 'inherit' });
  if (paste.status !== 0) return { ok: false, step: 'paste-buffer', status: paste.status };
  const enter = spawnSync(MUX, ['send-keys', '-t', session, 'Enter'], { stdio: 'inherit' });
  if (enter.status !== 0) return { ok: false, step: 'send-keys Enter', status: enter.status };
  return { ok: true };
}
```

### 改动 B — 删除旧 `psmuxLs`（line 88-92）

整块函数删掉，它被 `muxLs` 取代。

### 改动 C — 替换所有 `psmuxLs()` 调用为 `muxLs()`

搜所有 `psmuxLs(` 出现位置（line 179, 263, 379, 416），把调用名改成 `muxLs(`。不改语义。

对应错误消息里出现 `"psmux"` 字样（line 181 `not found in psmux` / line 266 `already exists in psmux` / line 266 下面的 `psmux attach`）要改：

- line 181: `'session "' + sessionName + '" not found in ' + MUX + '\n'`
- line 266（两处）: `MUX` 替代 `psmux`，包括 `already exists in ${MUX}` 和 `run:\n  ${MUX} attach -t ${sessionName} ...`

原则：凡是打给用户看的 "psmux" 字样都换成 `${MUX}`。

### 改动 D — `cmdLaunch` Step 4 换 mux（line 324-333）

```js
  // Step 4: Create psmux session with the command — one shot, no send-keys chain needed
  const ns = spawnSync(
    'psmux',
    ['new-session', '-d', '-s', sessionName, '--', 'pwsh', '-NoProfile', '-Command', pwshCmd],
    { stdio: 'inherit', env: childEnv }
  );
  if (ns.status !== 0) {
    try { fs.unlinkSync(regPath); } catch {}
    process.stderr.write(`psmux new-session failed (exit ${ns.status})\n`);
    process.exit(1);
  }
```

改为：

```js
  // Step 4: Create mux session with the command — one shot
  const childCmd = process.platform === 'win32' ? 'pwsh' : 'bash';
  const childCmdArgs = process.platform === 'win32'
    ? ['-NoProfile', '-Command', pwshCmd]
    : ['-lc', pwshCmd];
  const ns = muxNewSessionDetached(sessionName, childCmd, childCmdArgs, childEnv);
  if (ns.status !== 0) {
    try { fs.unlinkSync(regPath); } catch {}
    process.stderr.write(`${MUX} new-session failed (exit ${ns.status})\n`);
    process.exit(1);
  }
```

同时把 line 336 的 `attach_cmd` 模板的 `psmux` 换成 `${MUX}`。

**注意**：`pwshCmd` 在 bash 下不是合法输入。这次 spec 只保留 Windows 分支的真实行为；`bash -lc` 分支是占位（跨平台路径开启，但 pwshCmd 需要换成 bash 语法，属于 Wave 6 工作）。本 Wave 允许非 Windows 分支跑起来就行，内容不要求正确。

### 改动 E — `cmdKill`（line 362-363）

```js
  const r = spawnSync('psmux', ['kill-session', '-t', sessionName], { stdio: 'inherit' });
```

改为：

```js
  const r = muxKill(sessionName);
```

### 改动 F — `cmdSend` 重写（line 441-459）

删除 line 443-457 整段（send-keys -l + flushMs sleep + C-m + 300ms sleep + C-m bandaid），替换为：

```js
  const reg = readRegistry(sessionName);

  const res = muxPasteAndSubmit(sessionName, text);
  if (!res.ok) {
    process.stderr.write(`${MUX} ${res.step} failed (exit ${res.status})\n`);
    process.exit(1);
  }

  console.log(JSON.stringify({ sent: sessionName }));
```

（保留前面 `if (!sessionName)` / `assertValidSessionName` / `if (text === null)` 校验；保留尾部 `console.log`。）

### 改动 G — `cmdRun` 里所有 `psmux capture-pane` / `psmux kill-session` 替换

line 541, 566, 603, 646 的 `spawnSync('psmux', ['capture-pane', ...])` 改用 `muxCapture(sessionName, N)`。

line 362-363 的 `cmdKill` 已在改动 E 处理；`cmdRun` 末尾 kill（查找 `kill-session` 在 cmdRun 内部）也要换 `muxKill(sessionName)`。

### 改动 H — Bug 2 修复：codex 启动注入 notify（line 277-284）

当前：

```js
  if (runtime === 'codex') {
    const childSignalScript = path.join(PROJECT, '.claude', 'hooks', 'child_signal.js');
    const failGuard = `if ($LASTEXITCODE -ne 0) { node ${esc(childSignalScript)} --state stop_failure }`;
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `try { codex --dangerously-bypass-approvals-and-sandbox --model ${esc(model)}` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '') +
      `; ${failGuard} } catch { node ${esc(childSignalScript)} --state stop_failure }`;
  } else {
```

改为：

```js
  if (runtime === 'codex') {
    // bridge 路径：plugin 里 hooks/codex_hook_bridge.js（相对 launch_child.js 在 comm/）
    const bridgeScript = path.resolve(__dirname, '..', 'hooks', 'codex_hook_bridge.js');
    const bridgeForToml = bridgeScript.replace(/\\/g, '/');
    const notifyArg = `-c notify=["node","${bridgeForToml}"]`;
    const childSignalScript = path.join(PROJECT, '.claude', 'hooks', 'child_signal.js');
    const failGuard = `if ($LASTEXITCODE -ne 0) { node ${esc(childSignalScript)} --state stop_failure }`;
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `try { codex --dangerously-bypass-approvals-and-sandbox --model ${esc(model)} ${notifyArg}` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '') +
      `; ${failGuard} } catch { node ${esc(childSignalScript)} --state stop_failure }`;
  } else {
```

注意 `notifyArg` 不过 `esc`——它本身含引号和逗号，是 codex CLI 约定的 `-c key=value` 原始格式（value 是 JSON 数组字面量）。pwsh 里直接拼进命令行即可；路径已换成正斜杠规避反斜杠转义。

## 不做的事

- 不动 `hooks/codex_hook_bridge.js` 源码
- 不动 `hooks/child_signal.js` 源码
- 不动 `hooks/hooks.json`
- 不动 README / 其它 doc
- 不加 npm 依赖
- 不改 registry schema / signal 文件格式

## 自测场景

做完以上改动后，commit 前运行：

1. `node comm/launch_child.js` 无参数应打印 usage 且 exit 1
2. `node -e "const p = require('./comm/launch_child.js')"` —— 本脚本不 export，这条只是语法 sanity。改用 `node --check comm/launch_child.js`（允许的话）或直接跑 list：
3. `node comm/launch_child.js list` 应列出现有 session（如有）或空
4. 有活 mytest session 时：`node comm/launch_child.js status --session mytest` 应打印 registry json

完整 e2e 由用户在 test12 手工跑 `/agent-comm:run-codex / run-claude`，不是本 Wave 自测范围。

## Commit 约定

单 commit，message：

```
feat(wave5): mux 抽象 + codex notify 注入 — 修 submit race / stop 事件丢失

- 抽出 MUX/muxLs/muxKill/muxCapture/muxNewSessionDetached/muxPasteAndSubmit
- cmdSend 换 load-buffer + paste-buffer -p + Enter，绕过 codex paste_burst 抑制窗
- codex 启动加 -c notify=[node, bridge]，接通 agent-turn-complete → child_signal
- 所有 psmux 硬编码改走 mux 抽象（路径 windows→psmux / 其它→tmux）
```
