const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let signalDir = null;
let pollMs = 1000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--signalDir' && i + 1 < args.length) { signalDir = args[i + 1]; i++; }
  else if (args[i] === '--pollMs' && i + 1 < args.length) { pollMs = parseInt(args[i + 1], 10); i++; }
}

if (!signalDir) {
  if (!process.env.CLAUDE_PROJECT_DIR) {
    process.stderr.write('watch_child_stream: --signalDir or CLAUDE_PROJECT_DIR required\n');
    process.exit(1);
  }
  signalDir = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'signals', 'child-events');
}

const sessionsDir = path.join(path.dirname(signalDir), 'sessions');

fs.mkdirSync(signalDir, { recursive: true });

// LRU: 最多 100 条，重新 warn 时挪到末尾；超限淘汰最旧。
const ORPHAN_LRU_MAX = 100;
const orphanWarned = new Map();
function touchOrphan(session) {
  if (orphanWarned.has(session)) {
    const c = orphanWarned.get(session);
    orphanWarned.delete(session);
    orphanWarned.set(session, c + 1);
    return c + 1;
  }
  orphanWarned.set(session, 1);
  if (orphanWarned.size > ORPHAN_LRU_MAX) {
    const oldest = orphanWarned.keys().next().value;
    orphanWarned.delete(oldest);
  }
  return 1;
}

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

function tick() {
  let items;
  try {
    items = fs.readdirSync(signalDir).filter(f => f.endsWith('.signal')).sort();
  } catch { return; }

  for (const name of items) {
    const parts = name.slice(0, -7).split('__');
    if (parts.length !== 5) {
      try { fs.unlinkSync(path.join(signalDir, name)); } catch {}
      process.stderr.write(`watcher: skipped invalid ${name}\n`);
      continue;
    }

    const session = parts[1];
    const regPath = path.join(sessionsDir, `${session}.json`);
    const tombPath = path.join(sessionsDir, `${session}.tombstone.json`);
    if (!fs.existsSync(regPath) || fs.existsSync(tombPath)) {
      try { fs.unlinkSync(path.join(signalDir, name)); } catch {}
      const count = touchOrphan(session);
      if (count === 1) {
        process.stderr.write(`watcher: orphan signal for unregistered session "${session}" (further suppressed)\n`);
      }
      continue;
    }

    try { process.stdout.write(name + '\n'); } catch { return; }
    try { fs.unlinkSync(path.join(signalDir, name)); } catch {}
  }
}

setInterval(tick, pollMs);
tick();
