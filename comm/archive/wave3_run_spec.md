# Wave 3: `run` 子命令 — 一条命令派任务拿结果

## 目标
父 agent 用 **一条** `launch_child.js run` 搞定：起子 → 发 prompt → 等 stop signal → 取结果文件 → kill。无需父自己 launch/send/wait/capture/kill 4-5 步。

## 架构基础
仍然 psmux + CLI + hook（不引入新通信机制）。`run` 只做**编排**。

## CLI 签名

```
node launch_child.js run
  --runtime {claude|codex}             必填
  --model MODEL                        必填
  --session NAME                       可选，缺则自动 `run-<unix-ts>-<hex4>`
  --out RESULT_FILE                    可选，缺则 `.claude/signals/sessions/<session>.result.txt`
  --events-file EVENTS                 可选，写 JSONL 事件流
  --timeout-ms N                       可选，默认 300000（5min）
  --keep                               可选 flag，run 完不 kill session（默认 kill）
  --                                   分隔符
  PROMPT...                            必填，剩余 argv 拼接成 prompt 文本
```

示例：
```
node launch_child.js run --runtime codex --model gpt-5.4 --out r.txt -- "review foo.js"
```

## 内部流程

```
1. 解析 args，生成 session 名（若缺）
2. 调 launchInternal(runtime, session, model, [])：复用现有 launch 逻辑
   - 失败 return err（run 层面 exit 1）
3. **Boot ready**：轮询 `psmux capture-pane -t {session}` 每 300ms，直到出现 runtime-specific prompt marker（claude 的 `❯`/codex 的 `›`），最多 10 次（3s 封顶）。超时 → 继续往下（让 send 去碰）
4. 调 sendInternal(session, prompt)：复用 send 子命令
5. `sendAt = Date.now()`（用于过滤新事件）
6. **监听 signal 目录**（setInterval 200ms，与现有 watcher 共存）：
   - 过滤 `*__{session}__*.signal` **且文件名 ts 段 >= sendAt**（只消费 send 后的新事件，tolerate Monitor 并发消费者）
   - **只读不删**：run 不调 unlinkSync（避免与 watcher 双删）。watcher 正常消费即可
   - 若 --events-file：**在内存累积，收到终态才一次性 atomic 写**（tmp + rename，避免并发互踩）
   - state 是 stop / stop_failure → break（完成）
   - 超时：Date.now() - sendAt >= timeout → break（timed_out=true）
7. **结果提取**：
   - **codex runtime**：launch 时自动加 `--output-last-message <RESULT_FILE>`，让 codex 原生写文件。run 完 read file 即可（最可靠）
   - **claude runtime**：无原生参数 → capture-pane 取尾部 500 行 + 启发式 `●...❯` 段抽取最后一条 assistant 消息；失败 fallback 写整段 capture
8. 写 RESULT_FILE（若 codex 且 codex 已写 → 跳过）
9. 若非 --keep：killInternal(session)
10. stdout 输出 metadata JSON：
    {
      "session": "...",
      "runtime": "...",
      "final_state": "stop" | "stop_failure" | "timeout",
      "duration_ms": N,
      "out_file": "...",
      "events_file": "..." | null,
      "killed": true | false,
      "timed_out": true | false,
      "extract_source": "codex_native" | "pane_heuristic" | "pane_full_fallback"
    }
11. exit 0（正常完成 stop）/ 1（launch/send 失败或 stop_failure）/ 2（timeout）
```

## 内部 helper 抽取

从现有 `cmdLaunch` / `cmdSend` / `cmdKill` 抽出纯函数 helper：
- `launchInternal(runtime, session, model, passthrough, extraFlags)` → returns `{ok, sessionName, error?}`
- `sendInternal(session, text)` → returns `{ok, error?}`
- `killInternal(session)` → returns `{ok, hadRegistry, error?}`

**helper 纯返回，不 process.exit / throw**。由 cmdXxx 或 cmdRun 决定退出码。

codex 分支的 `--output-last-message` 通过 `extraFlags` 参数注入到 codex 命令行（避免 run 内再拼 psmux 命令）。

## 事件文件格式 (--events-file)

JSONL，每行一个 JSON：
```
{"ts":"2026-04-19T12:34:56.789Z","state":"permission","session":"run-17..."}
{"ts":"2026-04-19T12:34:58.012Z","state":"notification","session":"run-17..."}
{"ts":"2026-04-19T12:35:02.340Z","state":"stop","session":"run-17..."}
```

**写入方式**：run 过程中事件累积在内存；run 结束（stop / stop_failure / timeout）时**一次性原子写**（tmp + renameSync 覆盖，避免并发 run 同名 events-file 互踩）。
**禁 append 模式**：每次 run 独占写出本 run 的事件快照；同名文件后者完整覆盖前者。

## 结果文件格式 (--out)

纯 UTF-8 text，就是 `extractLastMessage` 的产物。

## 超时处理

`--timeout-ms N` 从 send 完成时刻开始计时：
- 超时 → capture-pane 当前内容写 RESULT_FILE
- `timed_out: true` / `final_state: "timeout"` / exit 2
- 仍尊重 --keep（默认 kill）

## Runtime 差异

只有 sendInternal 内部处理（已有，send 按 runtime 选 Enter / C-m）。`run` 层面对 runtime 透明。

## 已有子命令兼容

launch/send/kill/list/status/register 签名不变，只是内部改为调 helper。对外行为等价。

## 不支持场景

- **冲突 session 名**：--session 传了已存在 → launch 失败 → run exit 1（不 auto-retry）
- **child 发 permission**：`run` 不处理 permission signal（默认 --dangerously-* 已 bypass）。若需要 approval 流程，调用方用 --runtime 不带 bypass 手段另做
- **流式 result**：不支持；只有任务结束后一次性写 RESULT_FILE

## 自测

### Test A: 基本 claude 成功
```
node launch_child.js run --runtime claude --model glm-5.1 -- "输出字符串 pong 结束"
# 期望 stdout 有 final_state:"stop"，RESULT_FILE 含 "pong"
```

### Test B: codex runtime
```
node launch_child.js run --runtime codex --model gpt-5.4 -- "回复 OK 两个字"
# 期望 final_state:"stop"
```

### Test C: 超时
```
node launch_child.js run --runtime claude --model glm-5.1 --timeout-ms 5000 -- "写一首长诗，至少 500 字"
# 期望 5s 内超时 → final_state:"timeout" / timed_out:true，exit 2
```

### Test D: events-file
```
node launch_child.js run --runtime claude --model glm-5.1 --events-file e.jsonl -- "ping"
# 期望 e.jsonl 至少一条 {state:"stop"}
```

### Test E: --keep 不杀
```
node launch_child.js run --runtime claude --model glm-5.1 --session keep-me --keep -- "hi"
psmux ls | grep keep-me   # 期望还在
node launch_child.js kill --session keep-me  # 手清
```

### Test F: stop_failure
```
# 起一个会 exit 非 0 的 codex 命令（错误 model 名触发）
node launch_child.js run --runtime codex --model nonexistent-model -- "ping"
# 期望 final_state:"stop_failure"，exit 1
```

### Test G: watcher 并发
```
# 先起 Monitor 盯 signal 目录
# 另一 pwsh 同时 run
node launch_child.js run --runtime claude --model glm-5.1 -- "ping"
# 期望 run 仍能等到 stop 事件（因为用 ts 过滤而非独占消费）
```

### Test H: events-file 并发写
```
# 并发起 2 个 run 指向同一 --events-file
# 期望后完成的那个 run 完整覆盖文件，前者文件被替换，无半截内容
```

### Test I: extract fallback
```
# claude runtime，prompt 让子输出反常格式（纯代码块 / 无 ● 标记）
# 期望 extract_source 可能为 "pane_full_fallback"，RESULT_FILE 含原始 capture
```

### Test J: --keep + timeout
```
node launch_child.js run --runtime claude --model glm-5.1 --timeout-ms 2000 --keep --session slow -- "写 1000 字"
# 期望 timeout → 仍 kill? 不，--keep 生效，psmux slow 存活
psmux ls | grep slow
node launch_child.js kill --session slow
```

## 禁止

- 不动 signal 文件名协议 / hook 协议
- 不引 npm 依赖
- 不引入 stream 流式 API（一次性写 result）
- 不改 child_signal.js / watch_child_stream.js
- 不在 run 里做 approval 交互（bypass 已生效）

## 报告

- `launch_child.js` 大小变化
- 5 个 Test 输出（metadata JSON + RESULT_FILE 内容）
- 确认现有 launch/send/kill 子命令行为未变
