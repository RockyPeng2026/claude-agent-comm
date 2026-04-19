#!/usr/bin/env node
// Install claude-agent-comm framework into a target project's .claude/
//
// Usage: node install.js <target-project-dir> [--force]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const force = args.includes('--force');

if (!target) {
  process.stderr.write(`usage: node install.js <target-project-dir> [--force]\n`);
  process.exit(1);
}

const src = __dirname;
const dst = path.resolve(target);

if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) {
  process.stderr.write(`target not found or not a directory: ${dst}\n`);
  process.exit(1);
}

const hooksDst = path.join(dst, '.claude', 'hooks');
const commDst  = path.join(dst, '.claude', 'comm');
fs.mkdirSync(hooksDst, { recursive: true });
fs.mkdirSync(commDst,  { recursive: true });

function copy(from, to) {
  if (fs.existsSync(to) && !force) {
    console.log(`[skip] ${to} exists (use --force)`);
    return;
  }
  fs.copyFileSync(from, to);
  console.log(`[ok]   ${to}`);
}

// hooks/*.js
for (const name of fs.readdirSync(path.join(src, 'hooks'))) {
  if (!name.endsWith('.js')) continue;
  copy(path.join(src, 'hooks', name), path.join(hooksDst, name));
}

// comm/launch_child.js + CLAUDE.md
copy(path.join(src, 'comm', 'launch_child.js'), path.join(commDst, 'launch_child.js'));
copy(path.join(src, 'comm', 'CLAUDE.md'),       path.join(commDst, 'CLAUDE.md'));

console.log('');
console.log('=== 完成 ===');
console.log('下一步手动：');
console.log(`  1. merge ${path.join(src, 'examples', 'settings.local.json.example')} 的 hooks 段到`);
console.log(`     ${path.join(dst, '.claude', 'settings.local.json')}`);
console.log('  2. Codex 用户 copy 模板：');
console.log(`     cp "${path.join(src, 'codex-config', 'config.toml.template')}" "${path.join(dst, '.codex', 'config.toml')}"`);
console.log('     （手动改 notify 字段里的 bridge 绝对路径）');
console.log('  3. 目标项目 .gitignore 加：');
console.log('     .claude/signals/');
