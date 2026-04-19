const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const raw = process.argv[2] || fs.readFileSync(0, 'utf8');
let evt;
try { evt = JSON.parse(raw); } catch { process.exit(0); }

const state = evt.type === 'agent-turn-complete' ? 'stop' : null;
if (!state) process.exit(0);

const script = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'hooks', 'child_signal.js');
const r = spawnSync(process.execPath, [script, '--state', state], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 0);
