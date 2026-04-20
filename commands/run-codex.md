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
