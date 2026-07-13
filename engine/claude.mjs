// claude.mjs — adapter for `claude -p` (Claude Code headless).
// Sessions: first run mints a UUID via --session-id; later runs --resume it.
// Output: --output-format stream-json, one JSON event per line.
import crypto from 'node:crypto';
import path from 'node:path';
import { CLAUDE_CONTEXT_WINDOW } from './limits.mjs';

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
  const allowedTools = buildAllowedTools(harness, dataDir);
  if (allowedTools) args.push('--allowedTools', allowedTools);
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

function buildAllowedTools(harness, dataDir) {
  const configured = harness.allowedTools?.trim();
  const rules = configured ? [configured] : [];
  if (harness.readOnly && dataDir) {
    const dataPattern = absoluteClaudePathPattern(dataDir);
    rules.push(`Write(${dataPattern}/**)`, `Edit(${dataPattern}/**)`);
  }
  return rules.join(' ').trim();
}

function absoluteClaudePathPattern(dir) {
  const abs = path.resolve(dir).replaceAll('\\', '/').replace(/^\/+/, '');
  return `//${abs}`;
}

// Normalize a stream-json line into a Dispatch run event (or null to skip).
export function parseLine(line, state) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  if (obj.session_id) state.sessionId = obj.session_id;

  if (obj.type === 'rate_limit_event' && obj.rate_limit_info) {
    state.claudeRateLimit = { ...obj.rate_limit_info };
    if (obj.rate_limit_info.status === 'rejected') {
      state.rateLimitedUntil = (obj.rate_limit_info.resetsAt || 0) * 1000;
      return { kind: 'error', text: `claude rate limit (${obj.rate_limit_info.rateLimitType}) — resets ${new Date(state.rateLimitedUntil).toLocaleString()}` };
    }
    return null;
  }

  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') return { kind: 'system', text: `claude session ${obj.session_id} · model ${obj.model || '?'}` };
      return null;
    case 'assistant': {
      const model = obj.message?.model || state.model || '';
      if (model) state.model = model;
      const u = obj.message?.usage;
      if (u) {
        const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
        state.usage = {
          contextTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens),
          windowTokens: CLAUDE_CONTEXT_WINDOW,
          model,
          at: new Date().toISOString(),
        };
      }
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
