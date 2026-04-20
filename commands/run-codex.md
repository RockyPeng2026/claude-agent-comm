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
