// Public build telemetry. Provider lifecycle is observed; milestone reports are self-reported.
import fs from 'node:fs';
import readline from 'node:readline';

const clean = (v, n = 12000) => typeof v === 'string' ? v.slice(0, n) : '';
const tag = (prompt) => /\[dispatch-agent:([a-zA-Z0-9_-]{1,80})\]/.exec(prompt || '')?.[1];
const statuses = new Set(['pending', 'running', 'blocked', 'completed', 'failed', 'interrupted', 'closed', 'unknown']);
const nativeStatus = (s) => ({ pending_init: 'pending', in_progress: 'running', errored: 'failed', shutdown: 'closed', not_found: 'unknown' }[s] || (statuses.has(s) ? s : 'unknown'));

export function normalizeProgress(value) {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.agentId || '')) return null;
  const text = clean(value.text);
  const task = clean(value.task, 4000);
  const decision = clean(value.decision, 4000);
  if (!text && !task && !decision) return null;
  return { kind: 'agent', agentId: value.agentId, source: 'reported', text: text || decision || task,
    ...(task ? { task } : {}), ...(decision ? { decision } : {}),
    ...(statuses.has(value.status) ? { status: value.status } : {}),
    ...(['claude', 'codex'].includes(value.harness) ? { harness: value.harness } : {}),
    ...(value.model ? { model: clean(value.model, 160) } : {}),
    ...(value.effort ? { effort: clean(value.effort, 40) } : {}),
    ...(value.restart === true ? { restart: true } : {}),
  };
}

export function codexAgentEvents(event, state) {
  if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) return null;
  const it = event.item;
  if (it?.type === 'todo_list') return { kind: 'plan', agentId: 'orchestrator', text: 'Plan updated', steps: it.items || [] };
  if (it?.type !== 'collab_tool_call') return null;
  state.agentIds ||= {};
  const ids = [...new Set([...(it.receiver_thread_ids || []), ...Object.keys(it.agents_states || {})])];
  return ids.map((id) => {
    if (it.tool === 'spawn_agent') state.agentIds[id] = tag(it.prompt) || id;
    const a = it.agents_states?.[id];
    const status = a?.status ? nativeStatus(a.status) : it.tool === 'spawn_agent' ? 'pending' : undefined;
    return { kind: 'agent', source: 'provider', agentId: state.agentIds[id] || id, nativeId: id,
      ...(it.tool === 'send_input' ? { restart: true } : {}),
      ...(it.tool === 'spawn_agent' && it.prompt ? { task: clean(it.prompt, 4000) } : {}),
      ...(status ? { status } : {}),
      text: clean(a?.message) || `${it.tool.replaceAll('_', ' ')}${status ? `: ${status}` : ''}`,
    };
  });
}

export function claudeAgentEvents(obj, state) {
  state.agentIds ||= {};
  const parent = obj.parent_tool_use_id;
  if (parent) {
    const agentId = state.agentIds[parent] || parent;
    return (obj.message?.content || []).flatMap((p) => p.type === 'text' && p.text
      ? [{ kind: 'agent', agentId, source: 'provider', text: clean(p.text) }]
      : p.type === 'tool_use' ? [{ kind: 'agent', agentId, source: 'provider', text: `Tool: ${p.name}` }] : []);
  }
  if (obj.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(obj.subtype)) {
    const nativeId = obj.tool_use_id || obj.task_id;
    if (!nativeId) return null;
    const agentId = state.agentIds[nativeId] || nativeId;
    if (obj.task_id) state.agentIds[obj.task_id] = agentId;
    return { kind: 'agent', agentId, nativeId, source: 'provider',
      ...(obj.subtype === 'task_started' ? { task: clean(obj.description, 4000) } : {}),
      status: obj.subtype === 'task_notification' ? nativeStatus(obj.status) : 'running',
      text: clean(obj.summary || obj.description || obj.last_tool_name) || obj.subtype,
    };
  }
  const parts = obj.message?.content;
  if (!Array.isArray(parts)) return null;
  const events = [];
  for (const p of parts) {
    if (p.type === 'tool_use' && ['Agent', 'Task'].includes(p.name)) {
      const agentId = tag(p.input?.prompt) || p.id;
      state.agentIds[p.id] = agentId;
      events.push({ kind: 'agent', agentId, nativeId: p.id, source: 'provider', status: 'running',
        task: clean(p.input?.description || p.input?.prompt, 4000), text: clean(p.input?.prompt) || 'Agent spawned' });
    } else if (p.type === 'tool_result' && state.agentIds[p.tool_use_id]) {
      const text = typeof p.content === 'string' ? p.content : (p.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      // Background tools return before completion. Lifecycle notifications own their status.
      const background = /running.*background|async|agentId:/i.test(text);
      events.push({ kind: 'agent', source: 'provider', agentId: state.agentIds[p.tool_use_id],
        status: p.is_error ? 'failed' : background ? 'running' : 'completed', text: clean(text) || 'Agent returned' });
    }
  }
  if (!events.length) return null;
  // Keep public orchestrator commentary in mixed messages too.
  for (const p of parts) if (p.type === 'text' && p.text) events.push({ kind: 'text', text: p.text });
  return events;
}

// Stream, rather than load entire long-running transcripts into memory. Keep full
// agent state independently from the bounded transcript tail returned to the UI.
export async function readBuildTranscript(file) {
  const lines = [], agents = new Map();
  let meta = null;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      let item; try { item = JSON.parse(line); } catch { continue; }
      if (item.meta) meta = item.meta;
      lines.push(line);
      if (lines.length > 500) lines.shift();
      const ev = item.ev;
      if (ev?.kind !== 'agent') continue;
      const id = ev.agentId;
      const a = agents.get(id) || { agentId: id, history: [] };
      const finished = ['completed', 'failed', 'closed', 'interrupted'].includes(a.status);
      for (const k of ['task', 'status', 'nativeId', 'harness', 'model', 'effort']) {
        if (k === 'status' && finished && !ev.restart && ['pending', 'running', 'closed'].includes(ev.status)) continue;
        if (ev[k]) a[k] = ev[k];
      }
      a.text = ev.text; a.at = ev.at;
      a.history.push(ev); if (a.history.length > 80) a.history.shift();
      agents.set(id, a);
    }
  } finally { reader.close(); input.destroy(); }
  return { lines, meta, agents: [...agents.values()] };
}
