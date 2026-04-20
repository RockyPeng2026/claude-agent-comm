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
