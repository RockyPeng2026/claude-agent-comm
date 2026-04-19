#!/usr/bin/env node
// Empirical test: does 200ms buffer flush in send subcommand handle codex TUI reliably?
//
// Usage:
//   node examples/test_send_race.js <session>  # session must already be launched with codex runtime
//
// Runs 20 sends back-to-back and checks that each one reaches codex (capture-pane shows "Working").

const { spawnSync } = require('child_process');
const path = require('path');

const session = process.argv[2];
if (!session) {
  process.stderr.write('usage: node test_send_race.js <session>\n');
  process.exit(1);
}

const launcher = path.resolve(__dirname, '..', 'comm', 'launch_child.js');

let ok = 0, fail = 0;
for (let i = 1; i <= 20; i++) {
  const r = spawnSync('node', [launcher, 'send', '--session', session, '--text', `echo ping${i}`], { encoding: 'utf8' });
  if (r.status !== 0) { fail++; console.log(`send ${i}: FAIL (exit ${r.status})`); continue; }
  // wait for codex to register input; 1s between sends
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 1'], { stdio: 'ignore' });
  const cap = spawnSync('psmux', ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' });
  if (cap.stdout && (cap.stdout.includes(`ping${i}`) || cap.stdout.includes('Working'))) {
    ok++;
    console.log(`send ${i}: OK`);
  } else {
    fail++;
    console.log(`send ${i}: UNCERTAIN (pane has no ping${i} nor Working)`);
  }
  // let codex finish before next send
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { stdio: 'ignore' });
}

console.log(`\n=== Result: ok=${ok}, fail=${fail}, miss-rate=${((fail / 20) * 100).toFixed(1)}% ===`);
process.exit(fail > 0 ? 1 : 0);
