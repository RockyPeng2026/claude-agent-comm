# claude-agent-comm

> 中文版 → [README.zh.md](./README.zh.md)

Parent/child Claude Code agent communication framework. Parent Claude launches a child CLI (claude / codex / …) inside a psmux session; the child's Claude Code hooks write signal files; a watcher in the parent emits events through a `Monitor` tool. Result: **event-driven, non-blocking, multi-runtime** child agent orchestration.

## Directory

```
comm/                     # launcher + protocol doc + historical specs
  launch_child.js         # main script: subcommands launch / kill / list / status / send / register
  CLAUDE.md               # protocol (hook events, signal format, env contract, parent discipline)
  archive/                # prior wave specs (path references frozen to original project)
hooks/                    # hook callbacks (installed under target project's .claude/hooks/)
  child_signal.js         # hook callback — writes signal files
  watch_child_stream.js   # parent-side watcher — reads signal dir, emits to stdout
  codex_hook_bridge.js    # Codex notify → child_signal adapter
codex-config/
  config.toml.template    # Codex project-level config.toml template
examples/
  settings.local.json.example   # Claude Code hooks config sample
.claude-plugin/           # Claude Code plugin manifest + marketplace
skills/agent-comm/        # Plugin skill: operator guide for parent agent
install.js                # cross-platform Node installer
```

## Architecture

```
Parent Claude Code
  ↓ launch_child.js launch
  psmux / tmux session
  ↓ runs child CLI (claude / codex)
  ↓ child hooks fire (Stop / PermissionRequest / StopFailure / Notification)
  ↓ child_signal.js writes file
  .claude/signals/child-events/
    {ts}__{session}__{state}__{pid}__{guid}.signal
  ↓ watcher reads + unlinks
  Monitor captures stdout → task-notification → parent Opus wakes
```

## Requirements

- **Windows only** (current release): psmux + PowerShell 7 + Node.js 18+
- Target project must support Claude Code hooks (`settings.local.json`)

> ⚠️ *nix (tmux + bash) support is **not implemented**; code paths are hard-coded to `psmux` + PowerShell. Track via [issues](https://github.com/RockyPeng2026/claude-agent-comm/issues) or submit a PR with the tmux branch.

> 🔐 **Credentials**: claude runtime env (including `ANTHROPIC_AUTH_TOKEN`) is passed via `spawnSync`'s `env` option to `psmux new-session --`, and inherited down the psmux → pwsh → claude process chain. **No disk file, no psmux send-keys text.** Process listing shows pwsh/claude command lines (no token).
> 
> ⚠️ **passthrough warning**: unknown args after `launch --session X --model Y` are concatenated into the pwsh `-Command` string → **visible in child process argv / process listing**. **Never** put API keys, secrets, or PII-laden prompts into passthrough as `--flag value`. Inject sensitive content via `send --text "..."` after the session is up (not in argv).

## Install into a target project

```
node install.js /path/to/myproject [--force] [--codex]
```

Options:
- `--force` overwrite existing files
- `--codex` also install `.codex/config.toml` with the bridge path auto-resolved (skip manual editing)

The installer copies:
1. `hooks/*.js` → `<target>/.claude/hooks/`
2. `comm/launch_child.js` + `CLAUDE.md` → `<target>/.claude/comm/`
3. (with `--codex`) `.codex/config.toml` with resolved absolute path
4. Then prompts you to merge `examples/settings.local.json.example` hooks block into your `.claude/settings.local.json` and `.gitignore` `.claude/signals/`.

## As a Claude Code plugin

```
/plugin install RockyPeng2026/claude-agent-comm
```

Local development:
```
claude --plugin-dir D:/projects/claude-agent-comm
```

The plugin ships the `agent-comm` skill (`skills/agent-comm/SKILL.md`) that teaches parent Claude agents how to dispatch children, interpret events, and avoid common pitfalls.

## Usage

```powershell
# launch
node .claude/comm/launch_child.js launch --runtime claude --model glm-5.1 --session mywork

# send prompt (auto picks submit key by runtime: claude=Enter, codex=C-m)
node .claude/comm/launch_child.js send --session mywork --text "hello"

# status (registry + latest signal)
node .claude/comm/launch_child.js status --session mywork

# list active children
node .claude/comm/launch_child.js list

# kill (tombstone → psmux kill → delete registry on success)
node .claude/comm/launch_child.js kill --session mywork

# register existing psmux session (legacy/hand-built)
node .claude/comm/launch_child.js register --session oldsess --runtime claude --model glm-5.1
```

The parent must also run a watcher via Monitor:
```
Monitor { command: "node .claude/hooks/watch_child_stream.js --signalDir .claude/signals/child-events" }
```
See `comm/CLAUDE.md` for the full protocol.

## License

[MIT](./LICENSE)
