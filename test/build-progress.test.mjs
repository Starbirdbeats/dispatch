import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeProgress, readBuildTranscript } from '../engine/build-progress.mjs';
import * as codex from '../engine/codex.mjs';
import * as claude from '../engine/claude.mjs';
import { Runner } from '../engine/runner.mjs';

test('provider invocations keep orchestrator and worker selections independent, including resume', () => {
  for (const sessionId of [null, 'existing-session']) {
    const harness = { model: 'gpt-6-astra', effort: 'high', subagents: { model: 'gpt-5.6-terra', effort: 'low' } };
    const inv = codex.buildInvocation({ prompt: 'test', harness, dataDir: '/tmp/ticket', workspace: '/tmp/work', sessionId });
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gpt-6-astra');
    assert.ok(inv.args.includes('agents.default_subagent_model="gpt-5.6-terra"'));
    assert.ok(inv.args.includes('agents.default_subagent_reasoning_effort="low"'));
    const c = claude.buildInvocation({ prompt: 'test', harness: { model: 'claude-fable-5', effort: 'high', subagents: { model: 'claude-sonnet-5', effort: 'medium' } }, dataDir: '/tmp/ticket', sessionId });
    const worker = JSON.parse(c.args[c.args.indexOf('--agents') + 1])['dispatch-worker'];
    assert.equal(worker.model, 'claude-sonnet-5'); assert.equal(worker.effort, 'medium');
    assert.equal(c.args[c.args.indexOf('--effort') + 1], 'high');
  }
});

test('Codex native spawn and completion retain one worker identity and its assignment', () => {
  const state = {};
  const parse = (item) => codex.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'collab_tool_call', ...item } }), state);
  const start = parse({ tool: 'spawn_agent', receiver_thread_ids: ['child-1'], prompt: '[dispatch-agent:tests] Test the migration', agents_states: { 'child-1': { status: 'running' } } });
  assert.equal(start[0].agentId, 'tests'); assert.match(start[0].task, /Test the migration/);
  const end = parse({ tool: 'wait', receiver_thread_ids: ['child-1'], agents_states: { 'child-1': { status: 'completed', message: 'Three integration tests pass.' } } });
  assert.equal(end[0].agentId, 'tests'); assert.equal(end[0].status, 'completed');
  assert.equal(end[0].text, 'Three integration tests pass.');
});

test('Claude child text and result do not corrupt the orchestrator handoff or session', () => {
  const state = { sessionId: 'parent', finalText: 'parent handoff' };
  const parse = (o) => claude.parseLine(JSON.stringify(o), state);
  parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Agent', input: { prompt: '[dispatch-agent:ui] Build a form', description: 'Form' } }] } });
  const update = parse({ type: 'assistant', parent_tool_use_id: 'tool1', session_id: 'child', message: { content: [{ type: 'text', text: 'Form is ready for validation.' }] } });
  assert.equal(update[0].agentId, 'ui');
  parse({ type: 'result', parent_tool_use_id: 'tool1', session_id: 'child', result: 'child output' });
  assert.equal(state.sessionId, 'parent'); assert.equal(state.finalText, 'parent handoff');
  const finish = parse({ type: 'system', subtype: 'task_notification', tool_use_id: 'tool1', task_id: 'task1', status: 'completed', summary: 'Verified' });
  assert.equal(finish.agentId, 'ui'); assert.equal(finish.status, 'completed');
});

test('reports validate identities, statuses and bound untrusted text', () => {
  assert.equal(normalizeProgress({ agentId: '<script>', text: 'bad' }), null);
  assert.equal(normalizeProgress({ agentId: 'test' }), null);
  const ev = normalizeProgress({ agentId: 'test', text: 'x'.repeat(15000), status: '100%', decision: 'Keep existing API' });
  assert.equal(ev.text.length, 12000); assert.equal(ev.status, undefined); assert.equal(ev.source, 'reported');
});

test('progress reader handles split writes, malformed lines and service reattachment without replay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = [], sent = [];
  const runner = new Runner({}, (ev) => sent.push(ev));
  const entry = { runId: 'r1', runDir: dir, transcript: { write: (line) => written.push(line) } };
  const report = JSON.stringify({ agentId: 'tests', task: 'API tests', status: 'running', text: 'First test passes' });
  fs.writeFileSync(path.join(dir, 'progress.jsonl'), report.slice(0, 25));
  runner._drainProgress('t1', entry); assert.equal(sent.length, 0);
  fs.appendFileSync(path.join(dir, 'progress.jsonl'), report.slice(25) + '\ninvalid\n');
  runner._drainProgress('t1', entry); assert.equal(sent.length, 1);
  runner._drainProgress('t1', { ...entry, progressOffset: undefined }); assert.equal(sent.length, 1);
  assert.equal(JSON.parse(written[0]).ev.runId, 'r1');
});

test('long transcript snapshots retain early assignments separately from the display tail', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.jsonl');
  const rows = [{ meta: { harness: { model: 'gpt-6-astra' } } }, { ev: { kind: 'agent', agentId: 'worker', task: 'Original task', status: 'running', text: 'Started' } }, ...Array.from({ length: 550 }, (_, i) => ({ ev: { kind: 'text', text: `${i}` } })), { ev: { kind: 'agent', agentId: 'worker', status: 'completed', text: 'Done' } }];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const result = await readBuildTranscript(file);
  assert.equal(result.lines.length, 500); assert.equal(result.agents[0].task, 'Original task');
  assert.equal(result.agents[0].status, 'completed'); assert.equal(result.meta.harness.model, 'gpt-6-astra');
});

test('browser transcript merging removes reconnect duplicates and isolates run history', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function mergedTranscriptEvents('), src.indexOf('\nfunction renderBuildAgents('));
  const context = vm.createContext({}); vm.runInContext(fn, context);
  const events = context.mergedTranscriptEvents({ file: 'r2.jsonl', baseEvents: [{ id: '1', runId: 'r2', text: 'once' }], liveEvents: [{ id: '1', runId: 'r2', text: 'once' }, { id: 'old', runId: 'r1' }, { id: '2', runId: 'r2', text: 'new' }] });
  assert.equal(events.length, 2); assert.equal(events[1].text, 'new');
});
