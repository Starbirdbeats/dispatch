// Run-scoped MCP service. A local socket lets workers share one task registry,
// exchange messages and spawn across providers without exposing a network port.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as codex from './codex.mjs';
import * as claude from './claude.mjs';
import { bridgeInvocation } from './agent-bridge-config.mjs';

const adapters = { codex, claude };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
export const TOOL_DEFINITIONS = [
  { name: 'dispatch_spawn', description: 'Spawn a bounded worker task using either configured harness. Returns immediately. Use dispatch_wait for its result.', inputSchema: object({ agentId: string, task: string, harness: { enum: ['claude', 'codex'] } }, ['agentId', 'task']) },
  { name: 'dispatch_status', description: 'Read tasks, results, and your incoming messages. Workers should check this at milestones.', inputSchema: object({}) },
  { name: 'dispatch_message', description: 'Message any agent, including the orchestrator. Active agents receive messages when they check status; completed workers resume in their original session.', inputSchema: object({ agentId: string, message: string }, ['agentId', 'message']) },
  { name: 'dispatch_wait', description: 'Wait up to 10 seconds for a worker to finish, then return its current status and result. Repeat if still running.', inputSchema: object({ agentId: string }, ['agentId']) },
];

export class AgentBridge {
  constructor(config, { spawnProcess = spawn, adapters: providerAdapters = adapters } = {}) {
    this.config = config; this.spawnProcess = spawnProcess; this.adapters = providerAdapters;
    this.agents = new Map(); this.inbox = new Map(); this.closing = false;
  }

  emit(agent, text, extra = {}) {
    const event = { agentId: agent.id, task: agent.task, status: agent.status, text: String(text).slice(0, 12000),
      harness: agent.harness.type, model: agent.harness.model, effort: agent.harness.effort, ...extra };
    fs.appendFileSync(path.join(this.config.runDir, 'progress.jsonl'), JSON.stringify(event) + '\n');
  }

  snapshot() {
    return [...this.agents.values()].map((a) => ({ agentId: a.id, task: a.task, harness: a.harness.type,
      model: a.harness.model, effort: a.harness.effort, status: a.status, result: a.result || null }));
  }

  async call(name, args = {}, client = 'orchestrator') {
    if (this.closing) throw new Error('Run is stopping');
    if (client !== 'orchestrator' && !this.agents.has(client)) throw new Error('Unknown calling agent');
    if (name === 'dispatch_status') {
      const messages = this.inbox.get(client) || []; this.inbox.delete(client);
      return { agents: this.snapshot(), messages };
    }
    if (name === 'dispatch_spawn') {
      const id = args.agentId;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '') || id === 'orchestrator') throw new Error('Use a unique short agentId');
      if (this.agents.has(id)) throw new Error('Agent already exists; send it a message instead');
      if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000) throw new Error('A bounded task is required');
      if (this.agents.size >= this.config.maxAgents) throw new Error('Run agent limit reached');
      this.checkCapacity();
      const type = args.harness || this.config.defaultType;
      if (!['claude', 'codex'].includes(type)) throw new Error('Harness not configured for this run');
      const profile = this.config.profiles[type];
      if (!profile || !this.adapters[type]) throw new Error('Harness not configured for this run');
      const agent = { id, task: args.task, harness: { ...profile }, status: 'pending', sessionId: null, result: '' };
      this.agents.set(id, agent);
      this.start(agent, args.task);
      return { agentId: id, harness: type, status: agent.status };
    }
    if (name === 'dispatch_message') {
      if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 16000) throw new Error('A message is required');
      if (args.agentId !== 'orchestrator' && !this.agents.has(args.agentId)) throw new Error('Unknown recipient');
      const recipient = this.agents.get(args.agentId);
      if (recipient && !['pending', 'running'].includes(recipient.status)) {
        if (!recipient.sessionId) throw new Error('Worker has no resumable session. Spawn a new task.');
        this.checkCapacity();
        this.start(recipient, `Follow-up from ${client}:\n${args.message}`);
        return { delivered: 'resumed', agentId: recipient.id };
      }
      const inbox = this.inbox.get(args.agentId) || [];
      if (inbox.length >= 100) throw new Error('Recipient inbox is full');
      inbox.push({ from: client, message: args.message }); this.inbox.set(args.agentId, inbox);
      const sender = this.agents.get(client) || { id: 'orchestrator', task: 'Coordinate agent work', status: 'running', harness: {} };
      this.emit(sender, `Message to ${args.agentId}: ${args.message}`);
      return { delivered: 'queued', agentId: args.agentId };
    }
    if (name === 'dispatch_wait') {
      const a = this.agents.get(args.agentId);
      if (!a) throw new Error('Unknown agent');
      if (a.id === client) throw new Error('An agent cannot wait on itself');
      if (a.done && ['pending', 'running'].includes(a.status)) {
        let timer; await Promise.race([a.done, new Promise((r) => { timer = setTimeout(r, 10000); })]); clearTimeout(timer);
      }
      return this.snapshot().find((s) => s.agentId === a.id);
    }
    throw new Error('Unknown tool');
  }

  checkCapacity() {
    if ([...this.agents.values()].filter((a) => ['pending', 'running'].includes(a.status)).length >= this.config.maxConcurrent) throw new Error('Concurrent agent limit reached; wait for an existing task');
  }

  start(agent, task) {
    const adapter = this.adapters[agent.harness.type];
    const dataDir = path.join(this.config.runDir, 'agents', agent.id);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.rmSync(path.join(dataDir, 'last-message.txt'), { force: true });
    const bridge = { configFile: this.config.configFile, mcp: bridgeInvocation(this.config.configFile, agent.id) };
    const prompt = `You are Dispatch worker ${agent.id}. Complete only this assignment:\n${task}\n\nWorkspace: ${this.config.workspace}\nCoordinate with dispatch_status and dispatch_message; check incoming messages at milestones. Delegate only independent bounded tasks using dispatch_spawn, then wait for them. Do not use native subagents. Preserve other agents' edits. Report public progress and decisions in your normal messages, never private reasoning. Your final message is the task result, not the ticket handoff. ${agent.harness.readOnly ? 'This run is READ-ONLY: do not edit the workspace or commit.' : ''}`;
    const inv = adapter.buildInvocation({ prompt, harness: agent.harness, sessionId: agent.sessionId,
      dataDir, workspace: this.config.workspace, gitDir: this.config.gitDir, bridge });
    agent.status = 'running'; agent.result = ''; agent.state = { sessionId: inv.newSessionId || agent.sessionId };
    this.emit(agent, agent.sessionId ? 'Resuming worker with follow-up' : 'Worker started', { restart: true });
    let resolveDone; agent.done = new Promise((r) => { resolveDone = r; });
    let proc;
    try { proc = this.spawnProcess(inv.cmd, inv.args, { cwd: inv.cwd || this.config.workspace,
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: false }); }
    catch (error) { agent.status = 'failed'; agent.result = error.message; this.emit(agent, error.message); resolveDone(); return; }
    agent.proc = proc;
    const stdout = readline.createInterface({ input: proc.stdout });
    let stderr = '', settled = false;
    stdout.on('line', (line) => {
      fs.appendFileSync(path.join(dataDir, 'output.jsonl'), line + '\n');
      const parsed = adapter.parseLine(line, agent.state);
      for (const ev of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
        if (['text', 'tool', 'error', 'plan'].includes(ev.kind)) this.emit(agent, ev.text || ev.kind);
      }
    });
    proc.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    const finish = (code, error) => {
      if (settled) return; settled = true; clearTimeout(timer); stdout.close();
      agent.sessionId = agent.state.sessionId || agent.sessionId;
      agent.status = this.closing ? 'interrupted' : code === 0 ? 'completed' : 'failed';
      let finalText = agent.state.finalText;
      if (inv.lastMsgFile && fs.existsSync(inv.lastMsgFile)) finalText = fs.readFileSync(inv.lastMsgFile, 'utf8');
      agent.result = String(error?.message || finalText || stderr || `Worker exited with code ${code}`).slice(-16000);
      this.emit(agent, agent.result); agent.proc = null; resolveDone();
    };
    const timer = setTimeout(() => { proc.kill('SIGTERM'); setTimeout(() => { if (!settled) proc.kill('SIGKILL'); }, 1000).unref(); }, this.config.timeoutMs);
    proc.on('error', (e) => finish(-1, e)); proc.on('close', (code) => finish(code));
  }

  stop() {
    this.closing = true;
    for (const a of this.agents.values()) if (a.proc) a.proc.kill('SIGTERM');
  }
}

async function socketCall(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buf = '';
    socket.setTimeout(15000, () => socket.destroy(new Error('Agent bridge timeout')));
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 2_000_000) return socket.destroy(new Error('Response too large'));
      const end = buf.indexOf('\n'); if (end < 0) return;
      try { const result = JSON.parse(buf.slice(0, end)); socket.end(); result.error ? reject(new Error(result.error)) : resolve(result.result); } catch (e) { reject(e); socket.destroy(); }
    });
    socket.on('end', () => { if (!buf.includes('\n')) reject(new Error('Agent bridge disconnected')); });
  });
}

export async function serveBridge(configFile, client = 'orchestrator') {
  const config = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), configFile };
  let server, bridge;
  if (client === 'orchestrator') {
    bridge = new AgentBridge(config);
    server = net.createServer((socket) => {
      let buf = '';
      socket.on('error', () => {});
      socket.on('data', async (chunk) => {
        buf += chunk;
        if (buf.length > 64000) return socket.destroy();
        const end = buf.indexOf('\n'); if (end < 0) return;
        const raw = buf.slice(0, end); buf = '';
        try { const req = JSON.parse(raw); const result = await bridge.call(req.name, req.args, req.client); socket.end(JSON.stringify({ result }) + '\n'); }
        catch (e) { socket.end(JSON.stringify({ error: e.message }) + '\n'); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, resolve); });
    if (process.platform !== 'win32') fs.chmodSync(config.socketPath, 0o600);
  }
  const rl = readline.createInterface({ input: process.stdin });
  const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
  rl.on('line', async (line) => {
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request.id == null) return;
    try {
      if (request.method === 'initialize') return reply(request.id, { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dispatch-agents', version: '1.0.0' } });
      if (request.method === 'ping') return reply(request.id, {});
      if (request.method === 'tools/list') return reply(request.id, { tools: TOOL_DEFINITIONS });
      if (request.method !== 'tools/call') return reply(request.id, null, { code: -32601, message: 'Method not found' });
      const payload = { name: request.params?.name, args: request.params?.arguments || {}, client };
      const result = bridge ? await bridge.call(payload.name, payload.args, client) : await socketCall(config.socketPath, payload);
      reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) { reply(request.id, { isError: true, content: [{ type: 'text', text: e.message }] }); }
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    bridge?.stop(); server?.close(); rl.close();
    if (server && process.platform !== 'win32') { try { fs.unlinkSync(config.socketPath); } catch {} }
    setTimeout(() => { for (const a of bridge?.agents.values() || []) a.proc?.kill('SIGKILL'); process.exit(0); }, 1000).unref();
  };
  rl.once('close', stop); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveBridge(process.argv[2], process.argv[3]).catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
