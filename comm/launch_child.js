const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// PROJECT 解析优先级：CLAUDE_PROJECT_DIR（最可靠）> process.cwd()（Bash tool 正常） > __dirname 推断（最后兜底）
function resolveProject() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const cwd = process.cwd();
  // cwd 不是 plugin cache 目录时才用（plugin 模式下 cwd 可能是目标项目，也可能就是 launcher 目录）
  if (!cwd.includes('.claude/plugins/cache/') && !cwd.includes('.claude\\plugins\\cache\\')) return cwd;
  // fallback: __dirname 推断
  if (path.basename(path.dirname(__dirname)) === '.claude') return path.resolve(__dirname, '..', '..');
  return path.resolve(__dirname, '..');
}
const PROJECT = resolveProject();
const SESSIONS_DIR = path.join(PROJECT, '.claude', 'signals', 'sessions');

function esc(s) { return "'" + s.replace(/'/g, "''") + "'"; }

// ─── shared ───

const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/;
function assertValidSessionName(value, flagName) {
  if (!SESSION_NAME_RE.test(String(value || ''))) {
    process.stderr.write(`${flagName} "${value}" invalid (allowed: A-Z a-z 0-9 . _ -)\n`);
    process.exit(1);
  }
}

function sessionPath(session, suffix) {
  // suffix: '.json' | '.tombstone.json'
  const target = path.resolve(SESSIONS_DIR, `${session}${suffix}`);
  const rel = path.relative(SESSIONS_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write(`session name "${session}" resolves outside sessions dir\n`);
    process.exit(1);
  }
  return target;
}

function clearStaleTombstone(session) {
  const tombPath = sessionPath(session, '.tombstone.json');
  try { fs.unlinkSync(tombPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function isClaudeProxyMode() {
  return Boolean(process.env.ANTHROPIC_BASE_URL);
}
function defaultModelForRuntime(runtime) {
  if (runtime === 'codex') return 'gpt-5.4';
  return isClaudeProxyMode() ? 'glm-5.1' : 'claude-opus-4-7';
}
function hasArg(args, name) {
  return args.includes(name) || args.some(a => a.startsWith(`${name}=`));
}
function defaultPassthroughForRuntime(runtime, args) {
  if (runtime === 'codex' && !hasArg(args, '-c') && !args.some(a => a.includes('model_reasoning_effort'))) {
    return ['-c', 'model_reasoning_effort=high'];
  }
  return [];
}

function usage() {
  process.stderr.write(
    'Usage: node launch_child.js <subcommand> [options]\n' +
    '  launch    --runtime {claude|codex} --session NAME [--model X]\n' +
    '  register  --session NAME --runtime {claude|codex} [--model M] [--pid N] [--parent P] [--force]\n' +
    '  kill      --session NAME\n' +
    '  list\n' +
    '  status    --session NAME\n' +
    '  send      --session NAME --text "..."\n' +
    '  run       --runtime X [--model Y] [--session N] [--out FILE] [--events-file F] [--timeout-ms N] [--keep] -- PROMPT...\n' +
    '    default: codex=gpt-5.4 + -c model_reasoning_effort=high; claude=glm-5.1(proxy) | claude-opus-4-7(oauth)'
  );
  process.exit(1);
}

function readRegistry(session) {
  assertValidSessionName(session, '--session');
  const p = sessionPath(session, '.json');
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

  const regPath = sessionPath(sessionName, '.json');
  if (fs.existsSync(regPath) && !force) {
    process.stderr.write(`session "${sessionName}" already registered, use --force\n`);
    process.exit(1);
  }

  // Clear stale tombstone so watcher accepts future signals
  clearStaleTombstone(sessionName);

  const signalDir = path.join(PROJECT, '.claude', 'signals', 'child-events');
  const regData = {
    session: sessionName, runtime, model, pid,
    signal_dir: signalDir,
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
  let model = null, runtime = 'claude';
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
    // 仅当使用 z.ai 代理（ANTHROPIC_BASE_URL 非空）时要求 AUTH_TOKEN + API_TIMEOUT_MS；
    // 官方 OAuth（sonnet/opus 原生）无需 env。
    if (process.env.ANTHROPIC_BASE_URL) {
      const required = ['ANTHROPIC_AUTH_TOKEN', 'API_TIMEOUT_MS'];
      const missing = required.filter(k => !process.env[k]);
      if (missing.length) {
        process.stderr.write(`missing env: ${missing} (required when ANTHROPIC_BASE_URL set for proxy mode)\n`);
        process.exit(1);
      }
    }
  }

  model = model || defaultModelForRuntime(runtime);
  const effectivePassthrough = [...defaultPassthroughForRuntime(runtime, passthrough), ...passthrough];

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

  // Clear stale tombstone from prior session with same name
  clearStaleTombstone(sessionName);

  // Step 1: Build pwsh command (NO secrets typed — env comes via process inheritance)
  let pwshCmd;
  if (runtime === 'codex') {
    const childSignalScript = path.join(PROJECT, '.claude', 'hooks', 'child_signal.js');
    const failGuard = `if ($LASTEXITCODE -ne 0) { node ${esc(childSignalScript)} --state stop_failure }`;
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `try { codex --dangerously-bypass-approvals-and-sandbox --model ${esc(model)}` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '') +
      `; ${failGuard} } catch { node ${esc(childSignalScript)} --state stop_failure }`;
  } else {
    pwshCmd =
      `Set-Location ${esc(PROJECT)} -ErrorAction Stop; ` +
      `claude --model ${esc(model)} --dangerously-skip-permissions` +
      (effectivePassthrough.length ? ' ' + effectivePassthrough.map(esc).join(' ') : '');
  }

  // Step 2: Prepare child env (only expose ANTHROPIC_* to claude runtime; codex 走自己的 OAuth)
  const childEnv = { ...process.env };
  childEnv.CLAUDE_CHILD_HOOKS = '1';
  childEnv.CLAUDE_CHILD_SESSION = sessionName;
  childEnv.CLAUDE_CHILD_SIGNAL_DIR = signalDir;
  childEnv.CLAUDE_PROJECT_DIR = PROJECT;
  if (runtime === 'codex') {
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.API_TIMEOUT_MS;
  }

  // Step 3: Write registry BEFORE session starts (watcher needs it to accept first signal).
  // 不持久化 passthrough 原值（可能含 key / PII），仅记计数。
  const regPath = sessionPath(sessionName, '.json');
  const regData = {
    session: sessionName, runtime, model,
    pid: process.pid, signal_dir: signalDir,
    passthrough_count: effectivePassthrough.length,
    started_at: new Date().toISOString()
  };
  try {
    const ok = writeRegistryAtomic(regPath, regData, false);
    if (!ok) {
      process.stderr.write(`session "${sessionName}" already registered\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`registry write failed: ${e.message}\n`);
    process.exit(1);
  }

  // Step 4: Create psmux session with the command — one shot, no send-keys chain needed
  const ns = spawnSync(
    'psmux',
    ['new-session', '-d', '-s', sessionName, '--', 'pwsh', '-NoProfile', '-Command', pwshCmd],
    { stdio: 'inherit', env: childEnv }
  );
  if (ns.status !== 0) {
    try { fs.unlinkSync(regPath); } catch {}
    process.stderr.write(`psmux new-session failed (exit ${ns.status})\n`);
    process.exit(1);
  }

  console.log(JSON.stringify({ session: sessionName, runtime, model, attach_cmd: `psmux attach -t ${sessionName}` }));
}

// ─── kill ───

function cmdKill(subArgs) {
  let sessionName = null;
  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--session') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--session requires a value\n'); process.exit(1); }
      sessionName = subArgs[++i];
    }
  }
  if (!sessionName) { process.stderr.write('kill requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');

  readRegistry(sessionName);
  const regPath = sessionPath(sessionName, '.json');

  // Tombstone first — watcher sees it and discards in-flight signals
  atomicWrite(sessionPath(sessionName, '.tombstone.json'), {
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
    if (subArgs[i] === '--session') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--session requires a value\n'); process.exit(1); }
      sessionName = subArgs[++i];
    }
  }
  if (!sessionName) { process.stderr.write('status requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');

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
    if (subArgs[i] === '--session') {
      if (i + 1 >= subArgs.length || subArgs[i + 1].startsWith('--')) { process.stderr.write('--session requires a value\n'); process.exit(1); }
      sessionName = subArgs[++i];
    } else if (subArgs[i] === '--text') {
      // --text 的值不走 startsWith('--') 拦截（用户可能发以 -- 开头的 prompt）。
      // 用 `--text=<VALUE>` 显式传以 -- 开头的值避免歧义。
      if (i + 1 >= subArgs.length) { process.stderr.write('--text requires a value\n'); process.exit(1); }
      text = subArgs[++i];
    } else if (subArgs[i].startsWith('--text=')) {
      text = subArgs[i].slice('--text='.length);
    }
  }
  if (!sessionName) { process.stderr.write('send requires --session\n'); process.exit(1); }
  assertValidSessionName(sessionName, '--session');
  if (text === null) { process.stderr.write('send requires --text\n'); process.exit(1); }

  const reg = readRegistry(sessionName);

  const sk1 = spawnSync('psmux', ['send-keys', '-t', sessionName, '-l', text], { stdio: 'inherit' });
  if (sk1.status !== 0) { process.stderr.write(`send-keys -l failed (exit ${sk1.status})\n`); process.exit(1); }

  // Wait for TTY buffer to flush before hitting submit
  const flushMs = reg.runtime === 'codex' ? 500 : 200;
  await new Promise(r => setTimeout(r, flushMs));

  const submitKey = reg.runtime === 'codex' ? 'C-m' : 'Enter';
  const sk2 = spawnSync('psmux', ['send-keys', '-t', sessionName, submitKey], { stdio: 'inherit' });
  if (sk2.status !== 0) { process.stderr.write(`send-keys ${submitKey} failed (exit ${sk2.status})\n`); process.exit(1); }

  if (reg.runtime === 'codex') {
    await new Promise(r => setTimeout(r, 300));
    spawnSync('psmux', ['send-keys', '-t', sessionName, submitKey], { stdio: 'inherit' });
  }

  console.log(JSON.stringify({ sent: sessionName }));
}

// ─── run (orchestrates launch + send + wait + capture + kill) ───

async function cmdRun(subArgs) {
  let runtime = null, model = null, sessionName = null;
  let outFile = null, timeoutMs = 300000;
  let prompt = null;
  const passthrough = [];

  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (a === '--') { prompt = subArgs.slice(i + 1).join(' '); break; }
    else if (a === '--runtime') runtime = subArgs[++i];
    else if (a === '--model') model = subArgs[++i];
    else if (a === '--session') sessionName = subArgs[++i];
    else if (a === '--out') outFile = subArgs[++i];
    else if (a === '--timeout-ms') timeoutMs = parseInt(subArgs[++i], 10);
    else if (a === '--events-file') { subArgs[++i]; /* no-op */ }
    else if (a === '--keep') { /* no-op */ }
    else passthrough.push(a);
  }

  if (!runtime || (runtime !== 'claude' && runtime !== 'codex')) {
    process.stderr.write('run requires --runtime {claude|codex}\n'); process.exit(1);
  }
  if (!model) model = defaultModelForRuntime(runtime);
  if (!prompt || !prompt.trim()) { process.stderr.write('run requires PROMPT after --\n'); process.exit(1); }

  if (!sessionName) {
    const hex = require('crypto').randomBytes(2).toString('hex');
    sessionName = `run-${Math.floor(Date.now() / 1000)}-${hex}`;
  }
  assertValidSessionName(sessionName, '--session');

  if (!outFile) outFile = path.join(SESSIONS_DIR, `${sessionName}.result.txt`);

  const startMs = Date.now();

  // Direct CLI exec — no psmux, no TUI
  let cmd, args;
  if (runtime === 'codex') {
    const effectivePassthrough = [...defaultPassthroughForRuntime(runtime, passthrough), ...passthrough];
    cmd = 'codex';
    args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', model, ...effectivePassthrough, prompt];
  } else {
    cmd = 'claude';
    args = ['-p', '--model', model, '--dangerously-skip-permissions', ...passthrough, prompt];
  }

  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  const duration = Date.now() - startMs;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, res.stdout || '');

  let final_state, timed_out = false;
  if (res.signal === 'SIGTERM' || (res.error && res.error.code === 'ETIMEDOUT')) {
    final_state = 'timeout'; timed_out = true;
  } else if (res.status === 0) {
    final_state = 'stop';
  } else {
    final_state = 'stop_failure';
  }

  const out = {
    session: sessionName, runtime, model, final_state,
    duration_ms: duration,
    out_file: outFile,
    events_file: null,
    killed: false,
    timed_out,
    extract_source: 'cli_stdout',
  };
  if (res.stderr && (final_state !== 'stop' || timed_out)) {
    out.error_excerpt = res.stderr.split('\n').slice(-40).join('\n').trim();
  }
  console.log(JSON.stringify(out));

  if (timed_out) process.exit(2);
  if (final_state === 'stop_failure') process.exit(1);
  process.exit(0);
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
  case 'run':    cmdRun(subArgs).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); }); break;
  default: usage();
}
