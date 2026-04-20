const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const raw = process.argv[2] || fs.readFileSync(0, 'utf8');
let evt;
try { evt = JSON.parse(raw); } catch { process.exit(0); }

const state = evt.type === 'agent-turn-complete' ? 'stop' : null;
if (!state) process.exit(0);

// child_signal.js 与本 bridge 同在 plugin hooks/ 目录；用 __dirname 而不是 PROJECT 路径，
// 否则 PROJECT 下不存在 .claude/hooks/ 的场景（绝大多数测试项目）会静默 ENOENT。
const script = path.join(__dirname, 'child_signal.js');
const r = spawnSync(process.execPath, [script, '--state', state], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 0);
