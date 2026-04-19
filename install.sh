#!/usr/bin/env bash
# Install claude-agent-comm framework into a target project's .claude/
#
# Usage: ./install.sh /path/to/myproject [--force]

set -euo pipefail

TARGET="${1:-}"
FORCE=""
[[ "${2:-}" == "--force" ]] && FORCE="1"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 /path/to/target-project [--force]" >&2
  exit 1
fi

[[ -d "$TARGET" ]] || { echo "target not found: $TARGET" >&2; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$(cd "$TARGET" && pwd)"

HOOKS_DST="$DST/.claude/hooks"
COMM_DST="$DST/.claude/comm"
mkdir -p "$HOOKS_DST" "$COMM_DST"

copy() {
  local from="$1" to="$2"
  if [[ -f "$to" && -z "$FORCE" ]]; then
    echo "[skip] $to exists (use --force)"
    return
  fi
  cp "$from" "$to"
  echo "[ok]   $to"
}

for f in "$SRC"/hooks/*.js; do
  copy "$f" "$HOOKS_DST/$(basename "$f")"
done

copy "$SRC/comm/launch_child.js" "$COMM_DST/launch_child.js"
copy "$SRC/comm/CLAUDE.md"       "$COMM_DST/CLAUDE.md"

echo
echo "=== 完成 ==="
echo "下一步手动："
echo "  1. merge $SRC/examples/settings.local.json.example 的 hooks 段到"
echo "     $DST/.claude/settings.local.json"
echo "  2. Codex 用户 copy 模板："
echo "     cp $SRC/codex-config/config.toml.template $DST/.codex/config.toml"
echo "     （手动改 notify 字段里的 bridge 绝对路径）"
echo "  3. 目标项目 .gitignore 加："
echo "     .claude/signals/"
