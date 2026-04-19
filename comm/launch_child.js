const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..', '..');
const SESSIONS_DIR = path.join(PROJECT, '.claude', 'signals', 'sessions');

function esc(s) { return "'" + s.replace(/'/g, "''") + "'"; }

// ─── shared ───

function usage() {
  process.stderr.write(
    'Usage: node launch_child.js <subcommand> [options]\n' +
    '  launch    --runtime {claude|codex} --session NAME --model X\n' +
    '  register  --session NAME --runtime {claude|codex} [--model M] [--pid N] [--parent P] [--force]\n' +
    '  kill      --session NAME\n' +
    '  list\n' +
    '  status    --session NAME\n' +
    '  send      --session NAME --text "..."'
  );
  process.exit(1);
}

function readRegistry(session) {
  const p = path.join(SESSIONS_DIR, `${session}.json`);
  if (!fs.existsSync(p)) {
    process.stderr.write(`session "${session}" not found in registry\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function psmuxLs() {
  const r = spawnSync('psmux', ['ls'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return new Set();
  return new Set(r.stdout.trim().split('\n').filter(Boolean).map(l => l.split(':')[0]));
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  try { fs.unlinkSync(filePath); } catch {}
  fs.renameSync(tmpPath, filePath);
}

function writeRegistryAtomic(regPath, data, force) {
  // (1) Write complete tmp; (2) exclusive check (non-force); (3) rename replaces target atomically.
  // Target never has a no-file window: either old content or new content.
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  const tmpPath = `${regPath}.tmp.${process.pid}`;
  const content = JSON.stringify(data, null, 2);

  let fd = null;
  try {
    try {
      fd = fs.openSync(tmpPath, 'wx');
      fs.writeSync(fd, content);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  if (!force) {
    // Atomic exclusive create: linkSync succeeds only if target doesn't exist.
    try {
      fs.linkSync(tmpPath, regPath);
      fs.unlinkSync(tmpPath);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  }

  try {
    fs.renameSync(tmpPath, regPath); // cross-platform REPLACE_EXISTING
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

// ─── register ───

function cmdRegister(subArgs) {
  let sessionName = null, runtime = null, model = 'unknown';
  let pid = 0, parent = '', force = false;

  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--session requires a value\n'); process.exit(1); }
      sessionName = subArgs[++i];
      if (!/^[A-Za-z0-9._-]+$/.test(sessionName)) { process.stderr.write('--session contains invalid characters\n'); process.exit(1); }
    } else if (subArgs[i] === '--runtime') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--runtime requires a value\n'); process.exit(1); }
      runtime = subArgs[++i];
      if (runtime !== 'claude' && runtime !== 'codex') {
        process.stderr.write('--runtime must be claude or codex\n');
        process.exit(1);
      }
    } else if (subArgs[i] === '--model') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--model requires a value\n'); process.exit(1); }
      model = subArgs[++i];
    } else if (subArgs[i] === '--pid') {
      if (i + 1 >= subArgs.length) { process.stderr.write('--pid requires a value\n'); process.exit(1); }
      pid = parseInt(subArgs[++i], 10);
    } else if (subArgs[i] === '--parent') {
      if (i + 1 >= subArgs.length) { process.stderr.write('--parent requires a value\n'); process.exit(1); }
      parent = subArgs[++i];
    } else if (subArgs[i] === '--force') {
      force = true;
    }
  }

  if (!sessionName) { process.stderr.write('register requires --session\n'); process.exit(1); }
  if (!runtime) { process.stderr.write('register requires --runtime\n'); process.exit(1); }

  const alive = psmuxLs();
  if (!alive.has(sessionName)) {
    process.stderr.write(`session "${sessionName}" not found in psmux\n`);
    process.exit(1);
  }

  const regPath = path.join(SESSIONS_DIR, `${sessionName}.json`);
  if (fs.existsSync(regPath) && !force) {
    process.stderr.write(`session "${sessionName}" already registered, use --force\n`);
    process.exit(1);
  }

  const signalDir = path.join(PROJECT, '.claude', 'signals', 'child-events');
  const regData = {
    session: sessionName, runtime, model, pid,
    signal_dir: signalDir, passthrough: [],
    started_at: new Date().toISOString(),
    registered: true
  };
  if (parent) regData.parent = parent;

  try {
    const ok = writeRegistryAtomic(regPath, regData, force);
    if (!ok) {
      process.stderr.write(`session "${sessionName}" already registered\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`registry write failed: ${e.message}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify({ registered: sessionName, path: regPath }));
}

// ─── launch ───

function cmdLaunch(subArgs) {
  let model = 'glm-5.1', runtime = 'claude';
  let sessionName = `child-${Math.floor(Date.now() / 1000)}`;
  const passthrough = [];

  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--model') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--model requires a value\n'); process.exit(1); }
      model = subArgs[++i];
    } else if (subArgs[i] === '--session') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--session requires a value\n'); process.exit(1); }
      sessionName = subArgs[++i];
      if (!/^[A-Za-z0-9._-]+$/.test(sessionName)) { process.stderr.write('--session contains invalid characters\n'); process.exit(1); }
    } else if (subArgs[i] === '--runtime') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--runtime requires a value\n'); process.exit(1); }
      runtime = subArgs[++i];
      if (runtime !== 'claude' && runtime !== 'codex') {
        process.stderr.write('--runtime must be claude or codex\n');
        process.exit(1);
      }
    } else {
      passthrough.push(subArgs[i]);
    }
  }

  if (runtime === 'claude') {
    const required = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'API_TIMEOUT_MS'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      process.stderr.write(`missing env: ${missing}\n`);
      process.exit(1);
    }
  }

  const signalDir = path.join(PROJECT, '.claude', 'signals', 'child-events');

  // Pre-check: reject if same-name psmux session already exists (hand-built or legacy)
  const existing = psmuxLs();
  if (existing.has(sessionName)) {
    process.stderr.write(
      `session "${sessionName}" already exists in psmux; if you want to attach framework, run:\n` +
      `  launch_child.js register --session ${sessionName} --runtime ${runtime}\n`
    );
    process.exit(1);
  }

  // Step 1: Create psmux session
  const ns = spawnSync('psmux', ['new-session', '-d', '-s', sessionName], { stdio: 'inherit' });
  if (ns.status !== 0) {
    process.stderr.write(`psmux new-session failed (exit ${ns.status})\n`);
    process.exit(1);
  }

  // Step 2: Write registry BEFORE send-keys (watcher needs it to accept first signal)
  const regPath = path.join(SESSIONS_DIR, `${sessionName}.json`);
  const regData = {
    session: sessionName, runtime, model,
    pid: process.pid, signal_dir: signalDir,
    passthrough, started_at: new Date().toISOString()
  };
  try {
    const ok = writeRegistryAtomic(regPath, regData, false);
    if (!ok) {
      spawnSync('psmux', ['kill-session', '-t', sessionName]);
      process.stderr.write(`session "${sessionName}" already registered\n`);
      process.exit(1);
    }
  } catch (e) {
    spawnSync('psmux', ['kill-session', '-t', sessionName]);
    process.stderr.write(`registry write failed: ${e.message}\n`);
    process.exit(1);
  }

  // Step 3: Build command per runtime
  let cmdLine;
  if (runtime === 'codex') {
    const childSignalScript = path.join(PROJECT, '.claude', 'hooks', 'child_signal.js');
    const failGuard = `if ($LASTEXITCODE -ne 0) { node ${esc(childSignalScript)} --state stop_failure }`;
    cmdLine =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `$env:CLAUDE_CHILD_HOOKS='1'; ` +
      `$env:CLAUDE_CHILD_SESSION=${esc(sessionName)}; ` +
      `$env:CLAUDE_CHILD_SIGNAL_DIR=${esc(signalDir)}; ` +
      `$env:CLAUDE_PROJECT_DIR=${esc(PROJECT)}; ` +
      `try { codex --dangerously-bypass-approvals-and-sandbox --model ${esc(model)}` +
      (passthrough.length ? ' ' + passthrough.map(esc).join(' ') : '') +
      `; ${failGuard} } catch { node ${esc(childSignalScript)} --state stop_failure }`;
  } else {
    cmdLine =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `$env:CLAUDE_CHILD_HOOKS='1'; ` +
      `$env:CLAUDE_CHILD_SESSION=${esc(sessionName)}; ` +
      `$env:CLAUDE_CHILD_SIGNAL_DIR=${esc(signalDir)}; ` +
      `$env:CLAUDE_PROJECT_DIR=${esc(PROJECT)}; ` +
      `$env:ANTHROPIC_AUTH_TOKEN=${esc(process.env.ANTHROPIC_AUTH_TOKEN)}; ` +
      `$env:ANTHROPIC_BASE_URL=${esc(process.env.ANTHROPIC_BASE_URL)}; ` +
      `$env:API_TIMEOUT_MS=${esc(process.env.API_TIMEOUT_MS)}; ` +
      `claude --model ${esc(model)} --dangerously-skip-permissions` +
      (passthrough.length ? ' ' + passthrough.map(esc).join(' ') : '');
  }

  // Step 4: send-keys (child starts here — after registry so watcher accepts first signal)
  try {
    const sk1 = spawnSync('psmux', ['send-keys', '-t', sessionName, '-l', cmdLine], { stdio: 'inherit' });
    if (sk1.status !== 0) throw new Error(`send-keys -l failed (exit ${sk1.status})`);
    const sk2 = spawnSync('psmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'inherit' });
    if (sk2.status !== 0) throw new Error(`send-keys Enter failed (exit ${sk2.status})`);
  } catch (e) {
    spawnSync('psmux', ['kill-session', '-t', sessionName]);
    try { fs.unlinkSync(regPath); } catch {}
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }

  console.log(JSON.stringify({ session: sessionName, runtime, model, attach_cmd: `psmux attach -t ${sessionName}` }));
}

// ─── kill ───

function cmdKill(subArgs) {
  let sessionName = null;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session' && i + 1 < subArgs.length) sessionName = subArgs[++i];
  }
  if (!sessionName) { process.stderr.write('kill requires --session\n'); process.exit(1); }

  readRegistry(sessionName);
  const regPath = path.join(SESSIONS_DIR, `${sessionName}.json`);

  // Tombstone first — watcher sees it and discards in-flight signals
  atomicWrite(path.join(SESSIONS_DIR, `${sessionName}.tombstone.json`), {
    session: sessionName,
    killed_at: new Date().toISOString(),
    reason: 'user kill'
  });

  // Kill psmux session (best-effort — may already be dead)
  const r = spawnSync('psmux', ['kill-session', '-t', sessionName], { stdio: 'inherit' });
  if (r.status !== 0) {
    // Don't delete registry — session might still be alive (would become orphan)
    process.stderr.write(`kill-session exit ${r.status}, keeping registry\n`);
  } else {
    fs.unlinkSync(regPath);
  }

  console.log(JSON.stringify({ killed: sessionName }));
}

// ─── list ───

function cmdList() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tombstone.json'));
  const alive = psmuxLs();
  const entries = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    data.alive = alive.has(data.session);
    return data;
  });
  console.log(JSON.stringify(entries));
}

// ─── status ───

function cmdStatus(subArgs) {
  let sessionName = null;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session' && i + 1 < subArgs.length) sessionName = subArgs[++i];
  }
  if (!sessionName) { process.stderr.write('status requires --session\n'); process.exit(1); }

  const reg = readRegistry(sessionName);

  let last_event_state = null, last_event_at = null;
  const signalDir = reg.signal_dir || path.join(PROJECT, '.claude', 'signals', 'child-events');
  try {
    const signals = fs.readdirSync(signalDir)
      .filter(f => f.endsWith('.signal') && f.split('__')[1] === sessionName)
      .sort();
    if (signals.length > 0) {
      const parts = signals[signals.length - 1].slice(0, -7).split('__');
      last_event_state = parts[2];
      last_event_at = parts[0];
    }
  } catch {}

  const alive = psmuxLs();
  console.log(JSON.stringify({ ...reg, alive: alive.has(sessionName), last_event_state, last_event_at }));
}

// ─── send ───

async function cmdSend(subArgs) {
  let sessionName = null, text = null;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session' && i + 1 < subArgs.length) sessionName = subArgs[++i];
    else if (subArgs[i] === '--text' && i + 1 < subArgs.length) text = subArgs[++i];
  }
  if (!sessionName) { process.stderr.write('send requires --session\n'); process.exit(1); }
  if (!text) { process.stderr.write('send requires --text\n'); process.exit(1); }

  const reg = readRegistry(sessionName);

  const sk1 = spawnSync('psmux', ['send-keys', '-t', sessionName, '-l', text], { stdio: 'inherit' });
  if (sk1.status !== 0) { process.stderr.write(`send-keys -l failed (exit ${sk1.status})\n`); process.exit(1); }

  // Wait for TTY buffer to flush before hitting submit
  await new Promise(r => setTimeout(r, 200));

  const submitKey = reg.runtime === 'codex' ? 'C-m' : 'Enter';
  const sk2 = spawnSync('psmux', ['send-keys', '-t', sessionName, submitKey], { stdio: 'inherit' });
  if (sk2.status !== 0) { process.stderr.write(`send-keys ${submitKey} failed (exit ${sk2.status})\n`); process.exit(1); }

  console.log(JSON.stringify({ sent: sessionName }));
}

// ─── main ───

const argv = process.argv.slice(2);
if (argv.length === 0) usage();
const subArgs = argv.slice(1);

switch (argv[0]) {
  case 'launch':   cmdLaunch(subArgs); break;
  case 'register': cmdRegister(subArgs); break;
  case 'kill':     cmdKill(subArgs); break;
  case 'list':   cmdList(); break;
  case 'status': cmdStatus(subArgs); break;
  case 'send':   cmdSend(subArgs).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); }); break;
  default: usage();
}
