# Wave 7 — child_signal.js 路径从 PROJECT 改走 plugin

## 背景

Wave 6 测 codex run 超时 300s，原因是 codex 的 notify 链路静默失败：

```
codex → bridge (codex_hook_bridge.js) → child_signal.js （ENOENT）
```

bridge 里把 `child_signal.js` 路径拼到 `$CLAUDE_PROJECT_DIR/.claude/hooks/child_signal.js`。但 `child_signal.js` 的实际位置是 **plugin 的 hooks/ 目录**，**PROJECT 下不存在 `.claude/hooks/`**（绝大多数用户项目目录都没有这个子树）。

同理：`launch_child.js` 的 `failGuard` / `catch` 也拼 `$PROJECT/.claude/hooks/child_signal.js`，同样 ENOENT。正常退出路径里 `failGuard` 不触发所以 claude 测试没暴露问题，但一旦 codex/claude 异常，stop_failure 就写不进 signal。

## 目标

修两个文件里所有对 `child_signal.js` 的路径引用，让它始终解析到**与调用者同目录的 hooks/**（也就是 plugin 的 `hooks/` 目录），不再依赖 PROJECT 子树。

## 文件

1. `D:/projects/claude-agent-comm/hooks/codex_hook_bridge.js`
2. `D:/projects/claude-agent-comm/comm/launch_child.js`

不动其它文件。不改 `child_signal.js` 本身（它依赖 env，不依赖路径）。

## 精确改动

### 改动 A — `hooks/codex_hook_bridge.js` 改相对路径

当前 line 12：

```js
const script = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'hooks', 'child_signal.js');
```

改为：

```js
// child_signal.js 与本 bridge 同在 plugin hooks/ 目录；用 __dirname 而不是 PROJECT 路径，
// 否则 PROJECT 下不存在 .claude/hooks/ 的场景（绝大多数测试项目）会静默 ENOENT。
const script = path.join(__dirname, 'child_signal.js');
```

### 改动 B — `comm/launch_child.js` 改相对路径

当前 line 328：

```js
    const childSignalScript = path.join(PROJECT, '.claude', 'hooks', 'child_signal.js');
```

改为：

```js
    // child_signal.js 住在 plugin hooks/ 目录（与本 launcher 同级：./comm/launch_child.js → ../hooks/child_signal.js）
    const childSignalScript = path.resolve(__dirname, '..', 'hooks', 'child_signal.js');
```

line 329 和 336 对 `childSignalScript` 的**使用**不变（仍是 `${esc(childSignalScript)}`）。

## 不做的事

- 不改 `child_signal.js`
- 不改 `hooks/hooks.json`
- 不加新子命令 / 新参数
- 不改 README / CLAUDE.md / 其它 doc
- 不动 `notifyArg` / `bridgeForToml`（wave5/6 的改动保留）

## 自测场景

1. `node --check comm/launch_child.js` → `SYNTAX_OK`
2. `node --check hooks/codex_hook_bridge.js` → `SYNTAX_OK`
3. 验证 bridge 路径解析（手动调用模拟 codex notify）：
   ```
   cd D:/projects/claude-agent-comm
   CLAUDE_CHILD_HOOKS=1 \
   CLAUDE_CHILD_SESSION=wave7test \
   CLAUDE_CHILD_SIGNAL_DIR=./test/test13/.claude/signals/child-events \
   CLAUDE_PROJECT_DIR=./test/test13 \
   node hooks/codex_hook_bridge.js '{"type":"agent-turn-complete","thread-id":"x","turn-id":"y","cwd":"z","last-assistant-message":"ok"}'
   ```
   预期：
   - exit 0
   - `./test/test13/.claude/signals/child-events/` 下新增一个 `.signal` 文件（文件名含 `wave7test` 和 `stop`）
   - 把 `ls test/test13/.claude/signals/child-events/` 输出贴上
4. 实测 codex run（cwd = `D:/projects/claude-agent-comm/test/test13`）：
   ```
   node D:/projects/claude-agent-comm/comm/launch_child.js run --runtime codex -- 输出字符串 hello-wave7
   ```
   预期：final_state = `stop`（不是 timeout），duration_ms < 60000，result 含 `hello-wave7`。贴 JSON 输出
5. 跑完后 `psmux ls | grep run-` 清掉残留 session

## Commit 约定

单 commit：

```
fix(wave7): child_signal.js 路径从 PROJECT 改走 plugin hooks/

bridge 和 launch_child 的 failGuard 都在 $PROJECT/.claude/hooks/child_signal.js 
找 signal 脚本，但用户项目下根本没这子树——导致 codex notify 静默 ENOENT，
父 agent 只能靠 capture-pane 超时 fallback。改用 __dirname 相对定位。
```
