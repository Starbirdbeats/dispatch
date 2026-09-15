import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import net from 'node:net';
import { AgentBridge, TOOL_DEFINITIONS } from '../engine/agent-bridge.mjs';
import { createAgentBridge } from '../engine/agent-bridge-config.mjs';
import { normalizeProgress } from '../engine/build-progress.mjs';
import { Runner } from '../engine/runner.mjs';
import * as codex from '../engine/codex.mjs';
import * as claude from '../engine/claude.mjs';

function setup(t, type = 'codex', readOnly = false) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bridge-test-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const workerType = type === 'codex' ? 'claude' : 'codex';
  const harness = { type, model: type === 'codex' ? 'gpt-6-astra' : 'claude-fable-5', effort: 'high', readOnly,
    subagents: { type: workerType, model: workerType === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-5', effort: 'medium' } };
  const bridge = createAgentBridge({ runDir, workspace: runDir, harness, enabledProviders: ['claude', 'codex'] });
  const config = { ...JSON.parse(fs.readFileSync(bridge.configFile)), configFile: bridge.configFile };
  return { runDir, harness, bridge, config };
}

test('both directions configure a shared bridge instead of native-only workers, including resume', (t) => {
  for (const type of ['claude', 'codex']) {
    const { runDir, harness, bridge } = setup(t, type);
    for (const sessionId of [null, 'existing']) {
      const inv = ({ codex, claude })[type].buildInvocation({ prompt: 'test', harness, bridge, sessionId, dataDir: runDir, workspace: runDir });
      assert.match(inv.args.join(' '), /dispatch_agents/);
      assert.ok(!inv.args.includes('--agents'));
      if (type === 'codex') assert.ok(inv.args.includes('agents.enabled=false'));
      else {
        assert.ok(inv.args.includes('--disallowedTools'));
        assert.match(inv.args[inv.args.indexOf('--allowedTools') + 1], /mcp__dispatch_agents__dispatch_spawn/);
      }
    }
    const runner = new Runner({ effectiveHarness: () => harness }, () => {});
    const actual = runner.harnessFor({ overrides: {} }, { id: 'build', harness });
    assert.equal(actual.subagents.type, harness.subagents.type);
    assert.equal(actual.subagents.model, harness.subagents.model);
  }
});

test('workers use selected harness, exchange messages, delegate back, and resume', async (t) => {
  const { config } = setup(t);
  const calls = [];
  const service = new AgentBridge(config, { spawnProcess(cmd, args, options) {
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => { proc.stdout.end(); proc.emit('close', 143); };
    calls.push({ cmd, args, options, proc }); return proc;
  } });
  t.after(() => service.stop());
  await service.call('dispatch_spawn', { agentId: 'ui', task: 'Implement form' });
  assert.equal(calls[0].cmd, 'claude'); assert.ok(calls[0].args.includes('claude-sonnet-5'));
  await service.call('dispatch_message', { agentId: 'ui', message: 'Preserve existing fields' });
  assert.equal((await service.call('dispatch_status', {}, 'ui')).messages[0].message, 'Preserve existing fields');
  await service.call('dispatch_message', { agentId: 'orchestrator', message: 'Using existing components' }, 'ui');
  assert.equal((await service.call('dispatch_status')).messages[0].from, 'ui');
  await service.call('dispatch_spawn', { agentId: 'tests', task: 'Test form', harness: 'codex' }, 'ui');
  assert.equal(calls[1].cmd, 'codex'); assert.ok(calls[1].args.includes('gpt-6-astra'));
  calls[0].proc.stdout.write(JSON.stringify({ type: 'result', session_id: 'worker-session', result: 'Verified form' }) + '\n');
  calls[0].proc.stdout.end(); calls[0].proc.emit('close', 0);
  assert.equal((await service.call('dispatch_wait', { agentId: 'ui' })).status, 'completed');
  assert.equal((await service.call('dispatch_message', { agentId: 'ui', message: 'Check mobile too' })).delivered, 'resumed');
  assert.ok(calls[2].args.includes('worker-session'));
  const reports = fs.readFileSync(path.join(config.runDir, 'progress.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(normalizeProgress);
  assert.equal(reports[0].harness, 'claude'); assert.equal(reports[0].restart, true);
  assert.equal(reports[0].model, 'claude-sonnet-5');
  service.stop(); assert.ok(service.snapshot().every((a) => a.status === 'interrupted'));
});

test('bridge enforces provider availability, read-only, identity and concurrency limits', async (t) => {
  const { config, runDir, harness } = setup(t, 'claude', true);
  assert.ok(Object.values(config.profiles).every((p) => p.readOnly));
  assert.throws(() => createAgentBridge({ runDir, workspace: runDir, harness, enabledProviders: ['claude'] }), /disabled/);
  const service = new AgentBridge({ ...config, maxConcurrent: 0 });
  await assert.rejects(service.call('dispatch_spawn', { agentId: '../bad', task: 'x' }), /agentId/);
  await assert.rejects(service.call('dispatch_spawn', { agentId: 'a', task: 'x' }), /limit/);
  await assert.rejects(service.call('dispatch_message', { agentId: 'missing', message: 'x' }), /recipient/);
  await assert.rejects(service.call('dispatch_status', {}, 'missing'), /calling/);
});

test('MCP stdio serves tools and worker socket clients share the registry', async (t) => {
  const { bridge, config } = setup(t);
  const proc = spawn(bridge.mcp.command, bridge.mcp.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  const lines = readline.createInterface({ input: proc.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const request = async (id, method, params) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse((await iterator.next()).value);
  };
  assert.equal((await request(1, 'initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'dispatch-agents');
  assert.equal((await request(2, 'tools/list')).result.tools.length, TOOL_DEFINITIONS.length);
  const result = await request(3, 'tools/call', { name: 'dispatch_status', arguments: {} });
  assert.deepEqual(JSON.parse(result.result.content[0].text), { agents: [], messages: [] });
  assert.ok(fs.existsSync(config.socketPath));
  const socketResult = await new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socketPath); let response = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ name: 'dispatch_status', client: 'orchestrator', args: {} }) + '\n'));
    socket.on('data', (data) => { response += data; });
    socket.on('end', () => resolve(JSON.parse(response)));
  });
  assert.deepEqual(socketResult.result, { agents: [], messages: [] });
  proc.stdin.end();
  await new Promise((r) => proc.once('close', r));
  assert.equal(fs.existsSync(config.socketPath), false);
});
