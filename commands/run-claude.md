---
description: /agent-comm:run-claude [--model Y] -- PROMPT  (defaults --runtime claude，真事件驱动)
---
你是父 Claude。用户发 `/agent-comm:run-claude $ARGUMENTS`。**不调 subagent，不装 Monitor**。按以下执行：

1. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime claude $ARGUMENTS` → 得 session
2. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" notify --session <session>` → notify_armed
3. 告诉用户已启动，end turn
4. 等 FileChanged system-reminder 到达，把结果贴给用户
