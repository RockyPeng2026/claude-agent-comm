---
description: /agent-comm:run [--runtime X] [--model Y] -- PROMPT (真事件驱动)
---
你是父 Claude。用户发 `/agent-comm:run $ARGUMENTS`。**不调 subagent，不装 Monitor**。

1. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch $ARGUMENTS` → session
2. `node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" notify --session <session>`
3. 告诉用户已启动 end turn
4. 等 FileChanged system-reminder 贴结果
