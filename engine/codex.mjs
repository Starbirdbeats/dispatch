// codex.mjs — adapter for `codex exec` (Codex headless).
// Sessions: session/thread id captured from --json events; later runs use `codex exec resume <id>`.
// Final message: written to a file via -o (more reliable than scraping events across versions).
import path from 'node:path';

export function buildInvocation({ prompt, harness, sessionId, dataDir, workspace }) {
  const lastMsgFile = path.join(dataDir, 'last-message.txt');
  const args = ['exec'];
  const resume = Boolean(sessionId);
  if (resume) args.push('resume', sessionId);

  args.push('--json', '-o', lastMsgFile, '--skip-git-repo-check');
  // codex keeps .git read-only in workspace-write mode by default, which blocks the
  // "commit your work" contract of Build-style phases.
  args.push('-c', 'sandbox_workspace_write.allow_git_writes=true');
  if (harness.model) args.push('-m', harness.model);
  if (harness.effort) args.push('-c', `model_reasoning_effort="${harness.effort}"`);

  const sandbox = harness.permissions || 'workspace-write';
  if (resume) {
    // `exec resume` has no --sandbox/-C/--add-dir flags; config overrides cover it.
    args.push('-c', `sandbox_mode="${sandbox}"`);
    args.push('-c', `sandbox_workspace_write.writable_roots=["${dataDir}"]`);
  } else {
    args.push('--sandbox', sandbox, '-C', workspace, '--add-dir', dataDir);
  }
  args.push(prompt);
  return { cmd: 'codex', args, newSessionId: null, lastMsgFile };
}

// Normalize a --json JSONL line into a Dispatch run event. Handles both the
// thread/item event schema (current) and the older {id,msg:{...}} schema.
export function parseLine(line, state) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  const sid = obj.thread_id || obj.session_id || obj.msg?.session_id
    || (obj.type === 'session.created' ? obj.session?.id : null);
  if (sid) state.sessionId = sid;

  // Current schema
  if (obj.type === 'thread.started') return { kind: 'system', text: `codex thread ${obj.thread_id}` };
  if (obj.type === 'item.completed' && obj.item) {
    const it = obj.item;
    if (it.type === 'agent_message' && it.text) { state.finalText = it.text; return { kind: 'text', text: it.text }; }
    if (it.type === 'reasoning' && it.text) return { kind: 'thinking', text: truncate(it.text) };
    if (it.type === 'command_execution') return { kind: 'tool', text: `$ ${truncate(it.command || '')}` };
    if (it.type === 'file_change') return { kind: 'tool', text: `edit: ${(it.changes || []).map((c) => c.path).join(', ')}` };
    return null;
  }
  if (obj.type === 'turn.completed') {
    state.exitInfo = { usage: obj.usage };
    return { kind: 'result', text: 'turn completed' };
  }
  if (obj.type === 'turn.failed') {
    state.exitInfo = { error: obj.error };
    return { kind: 'error', text: `turn failed: ${JSON.stringify(obj.error)}` };
  }

  // Legacy schema
  const msg = obj.msg;
  if (msg) {
    if (msg.type === 'agent_message' && msg.message) { state.finalText = msg.message; return { kind: 'text', text: msg.message }; }
    if (msg.type === 'exec_command_begin') return { kind: 'tool', text: `$ ${truncate((msg.command || []).join(' '))}` };
    if (msg.type === 'task_complete') return { kind: 'result', text: 'task complete' };
    if (msg.type === 'error') return { kind: 'error', text: msg.message || 'error' };
  }
  return null;
}

function truncate(s, n = 200) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
