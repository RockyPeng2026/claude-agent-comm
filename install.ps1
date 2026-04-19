#!/usr/bin/env pwsh
# Install claude-agent-comm framework into a target project's .claude/
#
# Usage: ./install.ps1 -TargetProject D:/path/to/myproject [-Force]

param(
  [Parameter(Mandatory=$true)]
  [string]$TargetProject,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = (Resolve-Path $TargetProject).Path

if (-not (Test-Path $dst)) { throw "target not found: $dst" }

$hooksDst = Join-Path $dst '.claude/hooks'
$commDst  = Join-Path $dst '.claude/comm'
New-Item -ItemType Directory -Path $hooksDst, $commDst -Force | Out-Null

function CopyFile($from, $to) {
  if ((Test-Path $to) -and -not $Force) {
    Write-Host "[skip] $to exists (use -Force to overwrite)"
    return
  }
  Copy-Item $from $to -Force
  Write-Host "[ok]   $to"
}

# hooks/*.js
Get-ChildItem "$src/hooks/*.js" | ForEach-Object {
  CopyFile $_.FullName (Join-Path $hooksDst $_.Name)
}

# comm/launch_child.js + CLAUDE.md
CopyFile "$src/comm/launch_child.js" (Join-Path $commDst 'launch_child.js')
CopyFile "$src/comm/CLAUDE.md"       (Join-Path $commDst 'CLAUDE.md')

Write-Host ""
Write-Host "=== 完成 ==="
Write-Host "下一步手动："
Write-Host "  1. merge $src/examples/settings.local.json.example 的 hooks 段到"
Write-Host "     $dst/.claude/settings.local.json"
Write-Host "  2. Codex 用户 copy 模板："
Write-Host "     cp $src/codex-config/config.toml.template $dst/.codex/config.toml"
Write-Host "     （手动改 notify 字段里的 bridge 绝对路径）"
Write-Host "  3. 目标项目 .gitignore 加："
Write-Host "     .claude/signals/"
