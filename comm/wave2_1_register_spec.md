# Wave 2.1: 遗留/手建 psmux session 补 registry

## 目标
修 Wave 2 边缘 case：psmux session 活但无 registry（老版 launch / 手建 / 升级中断）→ watcher 当孤儿丢弃，父收不到事件，静默失败。

## 方案（B + D + E + A）

- **B**：新增 `register` 子命令补救存量
- **D**：`launch` 前检测同名 psmux session → 拦截提示用 register
- **E**：watcher 孤儿 signal 降噪（首次 warn，同 session 后续静默）
- **A**：文档加约束

## Step 1: 新增 `register` 子命令 (`launch_child.js`)

CLI：
```
node launch_child.js register --session X --runtime claude|codex [--model M] [--pid N] [--parent P] [--force]
```

参数：
- `--session`：必填，白名单 `^[A-Za-z0-9._-]+$`
- `--runtime`：必填，`claude` 或 `codex`
- `--model`：可选，默认 `unknown`
- `--pid`：可选，psmux session 里的子进程 pid（元数据，不强校验），默认 `0`
- `--parent`：可选，父 agent 标识（元数据，留空）
- `--force`：可选；session 已有 registry 时仍覆盖

行为：
1. 校验 session 存在于 `psmux ls`（不在 → stderr "session not found in psmux" + exit 1）
2. 如 `{session}.json` 已存在且无 `--force` → stderr "already registered, use --force" + exit 1
3. 原子写 registry（和 launch 同路径：tmp + rename）：
   ```json
   {
     "session": "...",
     "runtime": "...",
     "model": "...",
     "pid": <N>,
     "signal_dir": "<PROJECT>/.claude/signals/child-events",
     "passthrough": [],
     "started_at": "<now ISO>",
     "registered": true
   }
   ```
   `registered: true` 标识是后补的（和 launch 写的区分）
4. 打印 `{"registered": "NAME", "path": "..."}` JSON

## Step 2: `launch` 前 psmux 冲突检测

在 launch 的 step 1（new-session 之前）加：
- `psmux ls` 输出解析，检查是否已有同名 session
- 已有 → stderr：`"session already exists in psmux; if you want to attach framework, run: launch_child.js register --session NAME --runtime ..."` + exit 1

## Step 3: Watcher 孤儿降噪 (`watch_child_stream.js`)

当前：每个孤儿 signal 一条 stderr。
改：
- 内存表 `Map<sessionName, count>`
- 首次 session 孤儿 → stderr `"watcher: orphan signal for unregistered session "X" (further suppressed)"`
- 后续同 session 孤儿 → 仍 unlink 但不 stderr
- watcher 进程重启 → 表清零

注：这只降噪，不改变"丢弃孤儿"语义。

## Step 4: 文档更新 `.claude/comm/CLAUDE.md`

在"启动要求"或单独 section 加：

```
## N. 遗留 / 手建 session 补注册

子 session 必须经 `launch_child.js launch` 创建，或先调 `register` 子命令补 registry，
否则 watcher 丢弃所有该 session 的 signal，父静默失效。

补注册：
    node launch_child.js register --session NAME --runtime claude|codex

launch 检测到同名 psmux session 存在（未经框架创建）会直接拒绝并提示用 register。
```

## Step 5: 自测

### Test H: register 基本
```
# 前置：手工起个 psmux
psmux new-session -d -s legacy
node launch_child.js register --session legacy --runtime claude --model glm-5.1
# 期望：registry legacy.json 存在且有 registered:true
cat .claude/signals/sessions/legacy.json
psmux kill-session -t legacy
node launch_child.js kill --session legacy  # tombstone 流程一致
```

### Test I: register 防重复
```
node launch_child.js register --session legacy --runtime claude  # （前提 legacy 在 psmux）
node launch_child.js register --session legacy --runtime claude  # 期望 exit 1 "already registered"
node launch_child.js register --session legacy --runtime claude --force  # 期望成功覆盖
```

### Test J: register 非活 session
```
node launch_child.js register --session ghost123 --runtime claude
# 期望 exit 1 "session not found in psmux"
```

### Test K: launch 冲突检测
```
psmux new-session -d -s manual-collision
node launch_child.js launch --runtime claude --session manual-collision --model glm-5.1
# 期望 exit 1，提示 register 路径
psmux kill-session -t manual-collision
```

### Test L: watcher 降噪
```
# 手工放 3 个孤儿 signal（同 session）
for ($i=1; $i -le 3; $i++) {
  $f = "D:/English/.claude/signals/child-events/2026041912000$i.0000000Z__noreg__stop__9999$i__deadbeef.signal"
  '' | Out-File -Encoding ASCII $f
}
# 启 watcher（另 pwsh 窗口），5 秒后看 stderr
# 期望：只 1 行 "orphan signal for unregistered session noreg (further suppressed)"
```

## 禁止
- 不改 signal 协议（5 段 filename）
- 不动 child_signal.js
- 不加 npm 依赖
- 不引入 C（孤儿 signal 仍然丢弃，不 emit）

## 报告
- register 子命令功能验证（Test H/I/J/K/L）
- 文件大小变化
- diff 摘要
