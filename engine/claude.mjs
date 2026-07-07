// claude.mjs — adapter for `claude -p` (Claude Code headless).
// Sessions: first run mints a UUID via --session-id; later runs --resume it.
// Output: --output-format stream-json, one JSON event per line.
import crypto from 'node:crypto';

export function buildInvocation({ prompt, harness, sessionId, dataDir }) {
  // project,local only: user-level settings would fire Marcello's global hooks
  // (Telegram stop-notifications etc.) on every dispatch run.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local'];
  if (harness.model) args.push('--model', harness.model);
  if (harness.effort) args.push('--effort', harness.effort);

  if (harness.permissions === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (harness.permissions) {
    args.push('--permission-mode', harness.permissions);
  }
  if (harness.allowedTools?.trim()) args.push('--allowedTools', harness.allowedTools.trim());
  if (harness.chrome) args.push('--chrome');
  args.push('--add-dir', dataDir);

  let newSessionId = null;
  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    newSessionId = crypto.randomUUID();
    args.push('--session-id', newSessionId);
  }
  args.push(prompt);
  return { cmd: 'claude', args, newSessionId };
}

// Normalize a stream-json line into a Dispatch run event (or null to skip).
export function parseLine(line, state) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  if (obj.session_id) state.sessionId = obj.session_id;

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') return { kind: 'system', text: `claude session ${obj.session_id} · model ${obj.model || '?'}` };
      return null;
    case 'assistant': {
      const parts = obj.message?.content || [];
      const out = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text?.trim()) out.push({ kind: 'text', text: p.text });
        if (p.type === 'tool_use') out.push({ kind: 'tool', text: `${p.name} ${summarizeInput(p.input)}` });
      }
      return out.length ? out : null;
    }
    case 'result':
      state.finalText = obj.result || '';
      state.exitInfo = { subtype: obj.subtype, costUsd: obj.total_cost_usd, turns: obj.num_turns, durationMs: obj.duration_ms };
      return { kind: 'result', text: `result: ${obj.subtype} (${obj.num_turns ?? '?'} turns)` };
    default:
      return null;
  }
}

function summarizeInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch { return ''; }
}
