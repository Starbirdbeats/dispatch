// claude.mjs — adapter for `claude -p` (Claude Code headless).
// Sessions: first run mints a UUID via --session-id; later runs --resume it.
// Output: --output-format stream-json, one JSON event per line.
import crypto from 'node:crypto';
import path from 'node:path';
import { CLAUDE_CONTEXT_WINDOW } from './limits.mjs';
import { GRAFT_MCP_TOOLS } from './graft.mjs';
import { claudeAgentEvents } from './build-progress.mjs';
import { BRIDGE_TOOLS } from './agent-bridge-config.mjs';

export function buildInvocation({ prompt, harness, sessionId, dataDir, graft = null, bridge = null }) {
  // Keep unrelated user-level hooks out of automated phase runs.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local'];
  if (harness.model) args.push('--model', harness.model);
  if (harness.effort) args.push('--effort', harness.effort);
  if (bridge) args.push('--disallowedTools', 'Agent', 'Task');
  else if (harness.subagents) {
    args.push('--agents', JSON.stringify({ 'dispatch-worker': {
      description: 'Execute a bounded Dispatch build assignment. Use this agent for all delegated build tasks.',
      prompt: 'Complete only your assigned task. Preserve other agents work. Follow the Dispatch progress reporting instructions in your assignment. Report milestones, blockers and decisions as concise public summaries, never private reasoning.',
      model: harness.subagents.model || 'inherit',
      ...(harness.subagents.effort ? { effort: harness.subagents.effort } : {}),
    } }));
  }

  if (harness.permissions === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (harness.permissions) {
    args.push('--permission-mode', harness.permissions);
  }
  const allowedTools = buildAllowedTools(harness, dataDir, graft, bridge);
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (harness.chrome) args.push('--chrome');
  args.push('--add-dir', dataDir);
  if (graft?.enabled || bridge) {
    args.push('--mcp-config', JSON.stringify({
      mcpServers: {
        ...(bridge ? { dispatch_agents: bridge.mcp } : {}),
        ...(graft?.enabled ? { graft: {
          command: graft.mcp.command,
          args: graft.mcp.args,
        } } : {}),
      },
    }));
  }

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

function buildAllowedTools(harness, dataDir, graft, bridge) {
  const dataPattern = dataDir ? absoluteClaudePathPattern(dataDir) : null;
  const graftTools = graft?.enabled
    ? GRAFT_MCP_TOOLS.map((tool) => `mcp__graft__${tool}`)
    : [];
  const bridgeTools = bridge ? BRIDGE_TOOLS.map((tool) => `mcp__dispatch_agents__${tool}`) : [];
  if (harness.readOnly && dataPattern) {
    return [
      'Read',
      'Glob',
      'Grep',
      'LS',
      `Write(${dataPattern}/**)`,
      `Edit(${dataPattern}/**)`,
      ...graftTools,
      ...bridgeTools,
    ].join(' ');
  }
  const configured = harness.allowedTools?.trim();
  const rules = configured ? [configured] : [];
  rules.push(...bridgeTools);
  // Headless "manual" runs have no human to approve prompts, so every tool off the
  // allowlist is denied — carve out the ticket data dir or the mandatory dossier
  // update can never happen.
  if (harness.permissions === 'manual' && dataPattern) {
    rules.push(`Write(${dataPattern}/**)`, `Edit(${dataPattern}/**)`);
  }
  // --allowedTools is only emitted for an unrestricted invocation when the
  // user already configured a list. This avoids accidentally turning Graft on
  // into a global tool restriction.
  if (graftTools.length && (configured || harness.permissions === 'manual')) {
    rules.push(...graftTools);
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

  const delegated = claudeAgentEvents(obj, state);
  // Child messages must never replace the orchestrator's final handoff or usage.
  if (obj.parent_tool_use_id || delegated) return delegated;

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
        const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
        const output = num(u.output_tokens);
        // stream-json re-emits the same API message (same id, same usage) once per
        // content block — count each message once or the run totals multiply.
        const msgId = obj.message?.id || null;
        state.totals ||= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        state.countedMsgIds ||= new Set();
        if (!msgId || !state.countedMsgIds.has(msgId)) {
          if (msgId) state.countedMsgIds.add(msgId);
          state.totals.inputTokens += input;
          state.totals.cachedInputTokens += num(u.cache_read_input_tokens);
          state.totals.outputTokens += output;
        }
        state.usage = {
          contextTokens: input + output,
          windowTokens: CLAUDE_CONTEXT_WINDOW,
          inputTokens: state.totals.inputTokens,
          cachedInputTokens: state.totals.cachedInputTokens,
          outputTokens: state.totals.outputTokens,
          model,
          at: new Date().toISOString(),
        };
      }
      const parts = obj.message?.content || [];
      const out = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text?.trim()) out.push({ kind: 'text', text: p.text });
        if (p.type === 'tool_use') {
          const ev = { kind: 'tool', text: p.name || 'tool' };
          if (p.input !== undefined) ev.json = p.input;
          out.push(ev);
        }
      }
      return out.length ? out : null;
    }
    case 'result': {
      state.finalText = obj.result || '';
      state.exitInfo = { subtype: obj.subtype, costUsd: obj.total_cost_usd, turns: obj.num_turns, durationMs: obj.duration_ms };
      // The result event carries authoritative cumulative usage for the run — it also
      // covers messages the stream dropped, so prefer it over our per-message sums.
      const u = obj.usage;
      if (u && typeof u === 'object') {
        const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
        const inputTokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
        const outputTokens = num(u.output_tokens);
        if (inputTokens || outputTokens) {
          state.usage = {
            contextTokens: state.usage?.contextTokens ?? null,
            windowTokens: CLAUDE_CONTEXT_WINDOW,
            inputTokens,
            cachedInputTokens: num(u.cache_read_input_tokens),
            outputTokens,
            model: state.model || '',
            at: new Date().toISOString(),
          };
        }
      }
      return { kind: 'result', text: `result: ${obj.subtype} (${obj.num_turns ?? '?'} turns)` };
    }
    default:
      return null;
  }
}
