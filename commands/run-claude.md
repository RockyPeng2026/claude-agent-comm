---
description: /agent-comm:run-claude [--model Y] -- PROMPT  (defaults --runtime claude，事件驱动非阻塞)
---
你是父 Claude。用户发来 `/agent-comm:run-claude $ARGUMENTS`。**不要调用 subagent**。按下列步骤执行：

1. 用 Bash 运行：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/comm/launch_child.js" launch --runtime claude $ARGUMENTS
   ```
   （如果 $ARGUMENTS 里包含 `--model X`，解析 X 并加到 launch 命令，例如 `--model X`；其余参数原样转 passthrough。）
   解析 JSON 输出得到 `session`、`signal_dir`、`out_file`。

2-5. 同 `run-codex.md` 的 2-5 步。
