// hooks/notify_worker.js — detached: wait(child) → collect(child) → append delivery.
// 用法: node notify_worker.js --session CHILD_SESSION [--timeout-ms N]
// 写一行 JSON 到 $PROJECT/.claude/signals/agent-comm-deliveries.jsonl:
//   { ts, child_session, final_state, result_excerpt, out_file }
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
let childSession = null;
let timeoutMs = 900000; // 15 min
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session') childSession = args[++i];
  else if (args[i] === '--timeout-ms') timeoutMs = parseInt(args[++i], 10);
}
if (!childSession) { process.stderr.write('notify_worker requires --session\n'); process.exit(1); }

const launcher = path.resolve(__dirname, '..', 'comm', 'launch_child.js');
const nodeBin = process.execPath;

// 1) wait
const waitRes = spawnSync(nodeBin, [launcher, 'wait', '--session', childSession, '--timeout-ms', String(timeoutMs)], { encoding: 'utf8' });
let waitJson = {};
try { waitJson = JSON.parse(waitRes.stdout); } catch {}
const finalState = waitJson.final_state || 'timeout';

// 2) collect (--kill: 清理 psmux session)
const collectRes = spawnSync(nodeBin, [launcher, 'collect', '--session', childSession, '--kill'], { encoding: 'utf8' });
let collectJson = {};
try { collectJson = JSON.parse(collectRes.stdout); } catch {}

// 3) 追加 delivery
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const deliveriesFile = path.join(projectDir, '.claude', 'signals', 'agent-comm-deliveries.jsonl');
fs.mkdirSync(path.dirname(deliveriesFile), { recursive: true });
const entry = {
  ts: new Date().toISOString(),
  child_session: childSession,
  final_state: finalState,
  result_excerpt: collectJson.result_excerpt || '',
  out_file: collectJson.out_file || '',
  runtime: collectJson.runtime || waitJson.runtime || ''
};
fs.appendFileSync(deliveriesFile, JSON.stringify(entry) + '\n');
process.exit(0);
