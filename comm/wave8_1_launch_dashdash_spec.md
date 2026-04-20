# Wave 8.1 — cmdLaunch 支持 `-- PROMPT` 结尾分隔符（对齐 cmdRun）

## 背景

Wave 8 把 `/agent-comm:run-*` 改成父 Claude 直接调 `node launch_child.js launch --prompt "$ARGUMENTS"`。但 `$ARGUMENTS` 里含用户打的 `--` 分隔符（如 `-- 输出字符串 hi`），整块塞进 `--prompt` 后 codex 收到以 `--` 起头的 positional 报错：

```
error: unexpected argument '-- 输出字符串 hi' found
tip: to pass '-- 输出字符串 hi' as a value, use '-- -- 输出字符串 hi'
```

修：`cmdLaunch` 解析时识别 `--`，把后面整块当 prompt，和 `cmdRun` 的行为对齐。

## 文件

仅改 `D:/projects/claude-agent-comm/comm/launch_child.js` 和 3 个 command 文件。

## 改动

### 改动 A — `cmdLaunch` 参数循环加 `--` 分隔符支持

当前 `cmdLaunch` 参数循环（约 line 260-283）：

```js
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--model') {
      ...
    } else if (subArgs[i] === '--session') {
      ...
    } else if (subArgs[i] === '--runtime') {
      ...
    } else if (subArgs[i] === '--prompt') {
      if (i + 1 >= subArgs.length) { process.stderr.write('--prompt requires a value\n'); process.exit(1); }
      prompt = subArgs[++i];
    } else {
      passthrough.push(subArgs[i]);
    }
  }
```

在 `--prompt` 分支**之前**插入 `--` 分支：

```js
    } else if (subArgs[i] === '--') {
      // 分隔符后面整段当 prompt（对齐 cmdRun）
      prompt = subArgs.slice(i + 1).join(' ');
      break;
    } else if (subArgs[i] === '--prompt') {
```

两种路径（`--prompt X` 显式 flag / `-- rest` 尾分隔符）都能用。

### 改动 B — `commands/run-codex.md` 简化调用

把 step 1 的：

```
node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime codex --prompt "$ARGUMENTS"
```

改为（**把整个 $ARGUMENTS 原样追加，不包 --prompt**）：

```
node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime codex $ARGUMENTS
```

说明：$ARGUMENTS 里会含 `--model X` `-- prompt...` 之类，cmdLaunch 自己能解析。

### 改动 C — `commands/run-claude.md` 同 B

同样改 step 1：

```
node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime claude $ARGUMENTS
```

### 改动 D — `commands/run.md` 同 B

```
node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch $ARGUMENTS
```

（不加 `--runtime`，靠用户在 $ARGUMENTS 里显式传）

## 自测

1. `node --check comm/launch_child.js` → SYNTAX_OK
2. `node comm/launch_child.js launch --runtime codex --session w81t1 -- 输出字符串 hello-w81` → JSON 秒回
3. 等 15s，`node comm/launch_child.js wait --session w81t1 --timeout-ms 30000` → final_state=stop
4. `node comm/launch_child.js collect --session w81t1 --kill` → result_excerpt 含 `hello-w81`
5. 确认 `psmux ls | grep w81` 无残留

## 同步

同 wave8，改完 `cp comm/launch_child.js` 和 `cp -r commands/` 到 plugin cache。

## Commit 约定

```
fix(wave8.1): cmdLaunch 支持 `-- PROMPT` 分隔符，对齐 cmdRun

commands/run-*.md 原样转发 $ARGUMENTS 给 launch，让 cmdLaunch 自己解析。
修 codex 报 "unexpected argument '-- ...'" 错。
```
