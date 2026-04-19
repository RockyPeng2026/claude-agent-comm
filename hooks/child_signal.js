const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse --state <value>
const args = process.argv.slice(2);
let state = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state' && i + 1 < args.length) {
    state = args[i + 1];
    break;
  }
}
if (!state) {
  process.stderr.write('child_signal: --state is required\n');
  process.exit(1);
}

// Gate: only active in child mode
if (process.env.CLAUDE_CHILD_HOOKS !== '1') {
  process.exit(0);
}

// Session validation
const session = process.env.CLAUDE_CHILD_SESSION;
if (!session) {
  process.stderr.write('child_signal: CLAUDE_CHILD_SESSION is required (in child mode)\n');
  process.exit(0);
}
if (session.includes('__')) {
  process.stderr.write(`child_signal: CLAUDE_CHILD_SESSION must not contain '__', got "${session}"\n`);
  process.exit(0);
}

// Resolve signal directory
let dir = process.env.CLAUDE_CHILD_SIGNAL_DIR;
if (!dir) {
  if (!process.env.CLAUDE_PROJECT_DIR) process.exit(0);
  dir = path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'signals', 'child-events');
}

// Build filename: {yyyyMMddTHHmmss.fffffffZ}__{session}__{state}__{pid}__{guid8}.signal
const now = new Date();
const pad = (n, w) => String(n).padStart(w, '0');
const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}.${pad(now.getUTCMilliseconds(), 3)}0000Z`;
const guid8 = crypto.randomBytes(4).toString('hex');
const filename = `${ts}__${session}__${state}__${process.pid}__${guid8}.signal`;

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), '');
} catch (e) {
  process.stderr.write(`child_signal: failed to write event — ${e.message}\n`);
}
