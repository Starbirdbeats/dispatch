// codex.mjs — adapter for `codex exec` (Codex headless).
// Sessions: session/thread id captured from --json events; later runs use `codex exec resume <id>`.
// Final message: written to a file via -o (more reliable than scraping events across versions).
import path from 'node:path';
import { CODEX_CONTEXT_WINDOW } from './limits.mjs';

export function buildInvocation({ prompt, harness, sessionId, dataDir, workspace, gitDir }) {
  const lastMsgFile = path.join(dataDir, 'last-message.txt');
  const args = ['exec'];
  const resume = Boolean(sessionId);
  if (resume) args.push('resume', sessionId);

  args.push('--json', '-o', lastMsgFile, '--skip-git-repo-check');
  if (harness.model) args.push('-m', harness.model);
  if (harness.effort) args.push('-c', `model_reasoning_effort="${harness.effort}"`);
  // workspace-write blocks network by default — opt in per column/ticket (npm, ssh to MSI, etc.)
  if (harness.network) args.push('-c', 'sandbox_workspace_write.network_access=true');

  const readOnly = Boolean(harness.readOnly);
  const sandbox = readOnly ? 'workspace-write' : (harness.permissions || 'workspace-write');
  // .git is kept read-only inside workspace-write unless listed as a writable root,
  // which would block the "commit your work" contract of Build-style phases. In a
  // worktree checkout .git is a file pointing at the repo's shared git dir, so the
  // runner passes the resolved common dir (gitDir); fall back to workspace/.git.
  const gitWritable = gitDir || path.join(workspace, '.git');
  const roots = JSON.stringify(readOnly ? [dataDir] : [dataDir, gitWritable]);
  if (readOnly) args.push('-c', 'sandbox_permissions=["disk-full-read-access"]');
  if (resume) {
    // `exec resume` has no --sandbox/-C/--add-dir flags; config overrides cover it.
    args.push('-c', `sandbox_mode="${sandbox}"`);
    args.push('-c', `sandbox_workspace_write.writable_roots=${roots}`);
  } else {
    args.push('--sandbox', sandbox, '-C', readOnly ? dataDir : workspace);
    if (!readOnly) args.push('--add-dir', dataDir);
    args.push('-c', `sandbox_workspace_write.writable_roots=${roots}`);
  }
  args.push(prompt);
  return { cmd: 'codex', args, newSessionId: null, lastMsgFile };
}

// Normalize a --json JSONL line into a Dispatch run event. Handles both the
// thread/item event schema (current) and the older {id,msg:{...}} schema.
export function parseLine(line, state) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  const payload = obj.type === 'event_msg' && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  const event = payload || obj;

  const sid = event.thread_id || event.session_id || obj.thread_id || obj.session_id || obj.msg?.session_id
    || (event.type === 'session.created' ? event.session?.id : null)
    || (obj.type === 'session.created' ? obj.session?.id : null);
  if (sid) state.sessionId = sid;

  if (event.method === 'thread/tokenUsage/updated') {
    captureRateLimits(
      state,
      event.params?.rateLimits,
      event.params?.rate_limits,
      event.params?.tokenUsage?.rateLimits,
      event.params?.tokenUsage?.rate_limits,
    );
    if (event.params?.tokenUsage) applyThreadTokenUsage(event.params.tokenUsage, state);
    return null;
  }

  const tokenCount = event.type === 'token_count' ? event : (obj.msg?.type === 'token_count' ? obj.msg : null);
  if (tokenCount) {
    applyTokenCount(tokenCount, state);
    return null;
  }

  // Current schema
  if (event.type === 'thread.started') return { kind: 'system', text: `codex thread ${event.thread_id}` };
  if (event.type === 'item.completed' && event.item) {
    const it = event.item;
    if (it.type === 'agent_message' && it.text) { state.finalText = it.text; return { kind: 'text', text: it.text }; }
    if (it.type === 'reasoning' && it.text) return { kind: 'thinking', text: truncate(it.text) };
    if (it.type === 'command_execution') return { kind: 'tool', text: `$ ${truncate(it.command || '')}` };
    if (it.type === 'file_change') return { kind: 'tool', text: `edit: ${(it.changes || []).map((c) => c.path).join(', ')}` };
    return null;
  }
  if (event.type === 'turn.completed') {
    captureRateLimits(
      state,
      event.rateLimits,
      event.rate_limits,
      event.usage?.rateLimits,
      event.usage?.rate_limits,
    );
    state.exitInfo = { usage: event.usage };
    if (!state.usage && event.usage) applyUsageFallback(event.usage, state);
    return { kind: 'result', text: 'turn completed' };
  }
  if (event.type === 'turn.failed') {
    state.exitInfo = { error: event.error };
    return { kind: 'error', text: `turn failed: ${JSON.stringify(event.error)}` };
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

function applyThreadTokenUsage(tokenUsage, state) {
  const total = tokenUsage.total || tokenUsage.total_token_usage || tokenUsage.totalTokenUsage;
  const model = tokenUsage.model || state.model || '';
  captureRateLimits(state, tokenUsage.rateLimits, tokenUsage.rate_limits);
  applyUsageFallback(total, state, {
    model,
    windowTokens: tokenUsage.modelContextWindow || tokenUsage.model_context_window || CODEX_CONTEXT_WINDOW,
  });
}

function applyTokenCount(obj, state) {
  const info = obj.info || obj.token_count || obj;
  const usage = info.total_token_usage || info.totalTokenUsage || info.last_token_usage || info.lastTokenUsage || info.usage;
  const total = usage?.total_tokens ?? usage?.totalTokens;
  const model = info.model || obj.model || state.model || '';
  if (model) state.model = model;
  captureRateLimits(state, obj.rate_limits, obj.rateLimits, info.rate_limits, info.rateLimits);
  if (Number.isFinite(Number(total))) {
    state.usage = {
      contextTokens: Number(total),
      windowTokens: Number(info.model_context_window || info.modelContextWindow || CODEX_CONTEXT_WINDOW),
      model,
      at: new Date().toISOString(),
    };
  } else if (usage) {
    applyUsageFallback(usage, state, { model, windowTokens: info.model_context_window || info.modelContextWindow });
  }
}

function captureRateLimits(state, ...candidates) {
  const rateLimits = candidates.find((candidate) => (
    candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0
  ));
  if (rateLimits) state.rateLimits = rateLimits;
}

function applyUsageFallback(usage, state, { model = state.model || '', windowTokens = CODEX_CONTEXT_WINDOW } = {}) {
  if (!usage) return;
  const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  const total = usage.total_tokens ?? usage.totalTokens;
  const contextTokens = Number.isFinite(Number(total))
    ? Number(total)
    : num(usage.input_tokens) + num(usage.cached_input_tokens) + num(usage.output_tokens);
  if (!contextTokens) return;
  state.usage = {
    contextTokens,
    windowTokens: Number(windowTokens || CODEX_CONTEXT_WINDOW),
    model,
    at: new Date().toISOString(),
  };
}

function truncate(s, n = 200) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
