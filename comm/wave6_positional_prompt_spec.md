# Wave 6 — 位置参数 prompt 路径，废除 paste-buffer 注入

## 背景

Wave 5 用 `muxPasteAndSubmit`（tmux `load-buffer` + `paste-buffer -p` + `send-keys Enter`）替换 send-keys race。**psmux 3.3.0 实测证明 wave 5 方案不 work**：

| 缺陷 | 证据 |
|------|------|
| `load-buffer -b NAME FILE` 把 `-b NAME` 当文件名 | `buffer0: 24 bytes: "mybuf file content aaa\n"` |
| `load-buffer -`（stdin）静默失败 | `psmux list-buffers` 返回空 |
| `paste-buffer -p` 文本不到达 codex TUI | codex TUI 输入框依然是默认 placeholder |

[codex-rescue 调查](https://docs.rs/crate/psmux/3.3.0/source/docs/scripting.md)确认 psmux 3.3.0 这三条 API 是**未文档化的缩减实现**，不是可修 bug。

**新路径**：`codex [PROMPT]` 和 `claude [PROMPT]` 位置参数在 TUI 启动时 auto-submit。已实测：
- `codex --model gpt-5.4 -c 'notify=[...]' '用 Python 写 bubble sort'` → 秒出代码、TUI 继续 alive
- `claude --model claude-haiku-4-5 '用 Python 写 fibonacci(5)'` → 18s 内出 fib 代码、TUI 继续 alive

## 目标

1. `cmdLaunch` 接受 `--prompt TEXT`，codex / claude 两个分支都把 prompt 当**位置参数**拼到启动命令末尾
2. `cmdRun` 调 `cmdLaunch` 时把用户的 prompt 直接传过去，**跳过 Step 3（send）**
3. `cmdSend` 回退到 wave 5 前的 `send-keys -l + sleep + Enter` 模式（标 experimental，仅给未来多轮用；目前 `cmdRun` 不依赖它）
4. `muxPasteAndSubmit` 保留函数定义（有人可能派生调），但从 `cmdSend` 移除使用

## 文件

仅改 `D:/projects/claude-agent-comm/comm/launch_child.js`。不动 hooks/、不动 doc、不动测试。

## 精确改动

### 改动 A — `cmdLaunch` 加 `--prompt` 参数解析

line 260-283 的参数循环：

```js
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--model') {
      ...
    } else if (subArgs[i] === '--session') {
      ...
    } else if (subArgs[i] === '--runtime') {
      ...
    } else {
      passthrough.push(subArgs[i]);
    }
  }
```

在 `--runtime` 分支后、`else` 分支前，插入一条 `--prompt` 的 case：

```js
    } else if (subArgs[i] === '--prompt') {
      if (i + 1 >= subArgs.length) { process.stderr.write('--prompt requires a value\n'); process.exit(1); }
      prompt = subArgs[++i];
    } else {
```

并在函数顶部 `const passthrough = []` 那一行（line 263）后加：
```js
  let prompt = null;
```

### 改动 B — `cmdLaunch` 两个 pwshCmd 分支拼入 prompt

line 316-336。codex 分支 line 326-330 改为：

```js
    const promptSuffix = prompt ? ` ${esc(prompt)}` : '';
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `try { codex --dangerously-bypass-approvals-and-sandbox --model ${esc(model)} ${notifyArg}` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '') +
      promptSuffix +
      `; ${failGuard} } catch { node ${esc(childSignalScript)} --state stop_failure }`;
```

claude 分支 line 331-336 改为：

```js
  } else {
    const promptSuffix = prompt ? ` ${esc(prompt)}` : '';
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `claude --model ${esc(model)} --dangerously-skip-permissions` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '') +
      promptSuffix;
  }
```

**关键**：`prompt` 走 `esc()` 单引号包，pwsh 当字面量字符串传给 codex/claude。prompt 里含 `'` 由 `esc` 的 `''` double-single-quote 机制处理。

### 改动 C — `cmdRun` Step 1 launch 调用传 prompt，Step 3 send 整块删

line 540 当前：

```js
  // Step 1: launch
  const launchRes = runSelf(['launch', '--runtime', runtime, '--model', model, '--session', sessionName]);
```

改为：

```js
  // Step 1: launch (prompt 作为位置参数传给 runtime，启动即 submit)
  const launchRes = runSelf(['launch', '--runtime', runtime, '--model', model, '--session', sessionName, '--prompt', prompt]);
```

---

line 573-589（Step 2 boot poll + Step 3 send prompt）：

```js
  // Step 2: boot ready poll (max 3s)
  const bootMarker = runtime === 'codex' ? '›' : '❯';
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    const cap = muxCapture(sessionName);
    if (cap.stdout && cap.stdout.includes(bootMarker)) break;
  }

  // Step 3: send prompt
  const sendAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z/, (_, f) => '.' + f.padEnd(7, '0') + 'Z');
  const sendRes = runSelf(['send', '--session', sessionName, '--text', prompt]);
  const sendStart = Date.now();
  if (sendRes.status !== 0) {
    process.stderr.write(`run: send failed\n`);
    if (!keep) runSelf(['kill', '--session', sessionName]);
    process.exit(1);
  }
```

整块 Step 3 删掉；Step 2 保留做 boot ready poll（fatal 哨兵可能依赖 pane 有内容），但 Step 2 后面直接进 fatal 哨兵（原 line 591 开始）。注意：原代码里后面用到的 `sendAt` / `sendStart` 要找替代——搜 `sendAt` 和 `sendStart` 的后续使用位置，把它们改成以 launch 成功时间为基准。

具体：
- `sendAt` 用 `new Date().toISOString()` 格式化（launch 刚完成的时间）替代。找用到 `sendAt` 的代码，改成同格式的"launch 后"时间戳
- `sendStart` 改用 `const sendStart = Date.now();` 放在 Step 2 boot poll 之后

**注意**：如果 `sendAt` / `sendStart` 在代码里没有其他引用，就直接删，连同它们的声明都删。自测场景里跑 run 时应该能 catch 到这种剩余引用。

### 改动 D — `cmdSend` 回退到 send-keys + Enter

line 468-492（cmdSend 函数）。把 line 489 附近的：

```js
  const res = muxPasteAndSubmit(sessionName, text);
  if (!res.ok) {
    process.stderr.write(`${MUX} ${res.step} failed (exit ${res.status})\n`);
    process.exit(1);
  }
```

改为：

```js
  // experimental: 位置参数路径覆盖了 cmdRun 的首次 prompt；本函数仅给未来多轮用
  const sk1 = spawnSync(MUX, ['send-keys', '-t', sessionName, '-l', text], { stdio: 'inherit' });
  if (sk1.status !== 0) { process.stderr.write(`${MUX} send-keys -l failed (exit ${sk1.status})\n`); process.exit(1); }
  // paste_burst 抑制窗 ≤120ms，预留 300ms 冗余
  await new Promise(r => setTimeout(r, 300));
  const sk2 = spawnSync(MUX, ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'inherit' });
  if (sk2.status !== 0) { process.stderr.write(`${MUX} send-keys Enter failed (exit ${sk2.status})\n`); process.exit(1); }
```

### 改动 E — usage 字符串同步更新

line 63-76 的 `usage()` 函数，把 `launch` 那一行加 `--prompt "..."`：

```js
    'Usage: node launch_child.js <subcommand> [options]\n' +
    '  launch    --runtime {claude|codex} --session NAME [--model X] [--prompt "..."]\n' +
```

其他行不变。

## 不做的事

- 不删 `muxPasteAndSubmit` 函数定义（保留给潜在多轮场景；`cmdSend` 不再调）
- 不改 registry schema / signal 格式
- 不改 hooks/
- 不改 README / CLAUDE.md / 其它 doc（用户来改文档）
- 不加 prompt 长度限制（靠 pwsh 命令行长度上限自然限制；Windows 是 ~32K）

## 自测场景

完成后跑：

1. `node comm/launch_child.js` 无参数 → stderr 打印 usage，exit 1，usage 包含 `--prompt`
2. `node --check comm/launch_child.js` → 无语法错误
3. `node comm/launch_child.js list` → 正常输出 JSON（当前没有新 session 也行）
4. 实测 run（在 `D:/projects/claude-agent-comm/test/test13` 下）：
   ```
   node comm/launch_child.js run --runtime codex -- 输出字符串 hello-wave6
   ```
   预期：TUI 启动 + 位置参数 auto-submit + codex 回答里包含 `hello-wave6` + stop 事件 + 进程退出。把 stdout 的 JSON（final_state / extract_source / result 节选）贴到报告
5. 同样 prompt 跑 claude：
   ```
   node comm/launch_child.js run --runtime claude --model claude-haiku-4-5-20251001 -- 输出字符串 hello-wave6-claude
   ```
   预期：claude TUI 启动 + auto-submit + 回答含 `hello-wave6-claude`

## Commit 约定

单 commit：

```
feat(wave6): 位置参数 prompt 路径，废除 paste-buffer 注入

- cmdLaunch 加 --prompt：codex/claude TUI 启动时 auto-submit
- cmdRun 跳过 Step 3 send subcommand，prompt 走 launch
- cmdSend 回退 send-keys -l + Enter，标 experimental
- muxPasteAndSubmit 保留定义但无调用者（psmux 3.3.0 实测不支持 tmux buffer API）
```
