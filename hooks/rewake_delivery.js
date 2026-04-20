// hooks/rewake_delivery.js — FileChanged hook body.
// 被 Claude Code 以 asyncRewake=true 触发。读 deliveries.jsonl 新增行，
// 用 stderr 发 result + exit 2 让父 Claude 把 stderr 当 system-reminder 读取。
// 状态文件: $PROJECT/.claude/signals/.deliveries.read.marker 存已读 offset。
const fs = require('fs');
const path = require('path');

// hook 读 stdin 拿 session / file_path 等元数据（JSON）
let hookInput = '';
try { hookInput = fs.readFileSync(0, 'utf8'); } catch {}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const deliveriesFile = path.join(projectDir, '.claude', 'signals', 'agent-comm-deliveries.jsonl');
const markerFile = path.join(projectDir, '.claude', 'signals', '.deliveries.read.marker');

let consumed = 0;
try { consumed = parseInt(fs.readFileSync(markerFile, 'utf8'), 10) || 0; } catch {}

let content = '';
try { content = fs.readFileSync(deliveriesFile, 'utf8'); } catch { process.exit(0); }
if (content.length <= consumed) process.exit(0);

const newPart = content.slice(consumed);
const newLines = newPart.split('\n').filter(l => l.trim());
if (newLines.length === 0) process.exit(0);

const msgs = [];
for (const line of newLines) {
  try {
    const e = JSON.parse(line);
    msgs.push(`[agent-comm] child ${e.child_session} ${e.final_state}: ${(e.result_excerpt || '').split('\n').slice(0, 10).join(' | ')}`);
  } catch {}
}

fs.writeFileSync(markerFile, String(content.length));
if (msgs.length === 0) process.exit(0);

process.stderr.write(msgs.join('\n') + '\n');
process.exit(2);
