// server.mjs — Dispatch: kanban OS for multi-harness agent work.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Store } from './store.mjs';
import { Runner } from './engine/runner.mjs';
import { REGISTRY, loadCodexDefaults, probe } from './registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DISPATCH_PORT || 4400);

const BOOT_ID = crypto.randomUUID(); // stale open tabs self-reload when this changes
const store = new Store();
loadCodexDefaults();
let health = { claude: { ok: false }, codex: { ok: false } };
probe().then((h) => { health = h; broadcast({ type: 'state-changed' }); });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

const runner = new Runner(store, broadcast);

// ---- auto-dispatch scheduler ----
// Every tick (60s): fire tickets whose scheduledAt has come due. Every sweep interval
// (default 5 min): start the pipeline for any unscheduled ticket sitting in an intake column.
const TICK_MS = 60_000;
let nextSweepAt = Date.now() + 5 * 60_000; // grace period after boot before the first sweep
function autoDispatchTick() {
  const s = store.board.settings;
  if (s.autoDispatch === false) return;
  const now = Date.now();
  const sweep = now >= nextSweepAt;
  if (sweep) nextSweepAt = now + (s.autoDispatchEveryMin || 5) * 60_000;

  for (const t of store.tickets.values()) {
    const col = store.column(t.columnId);
    if (!col || col.role !== 'intake' || t.status !== 'idle') continue;
    const due = t.scheduledAt
      ? now >= new Date(t.scheduledAt).getTime()  // server-local time, same tz as the browser
      : sweep;
    if (!due) continue;
    const next = store.nextAgentColumn(col.id);
    if (!next) continue;
    store.appendActivity(t.id, {
      kind: 'system', by: 'engine',
      text: t.scheduledAt ? `auto-dispatch: scheduled time ${t.scheduledAt} reached` : 'auto-dispatch: backlog sweep',
    });
    if (t.scheduledAt) { t.scheduledAt = null; store.saveTicket(t.id); } // no refire if it ever returns
    runner.moveTicket(t.id, next.id, { by: 'engine', autoRun: true });
  }
  // Even a no-op sweep advances nextSweepAt — push it so client countdowns reset.
  if (sweep) broadcast({ type: 'state-changed' });
}
setInterval(() => { try { autoDispatchTick(); } catch (e) { console.error('auto-dispatch:', e); } }, TICK_MS);

runner.recover();

// ---- state ----
app.get('/api/state', (_req, res) => {
  res.json({
    board: store.board,
    tickets: [...store.tickets.values()],
    registry: REGISTRY,
    health,
    runs: runner.snapshot(),
    scheduler: {
      autoDispatch: store.board.settings.autoDispatch !== false,
      nextSweepAt,
    },
    serverBoot: BOOT_ID,
  });
});

app.post('/api/probe', async (_req, res) => {
  health = await probe();
  broadcast({ type: 'state-changed' });
  res.json(health);
});

// ---- tickets ----
app.post('/api/tickets', (req, res) => {
  const { title, description, workspace, columnId, overrides, scheduledAt } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const t = store.createTicket({ title: title.trim(), description, workspace, columnId, overrides, scheduledAt });
  broadcast({ type: 'state-changed' });
  const col = store.column(t.columnId);
  if (col?.autoRun && col.role === 'agent') runner.enqueue(t.id, { by: 'human' });
  res.json(t);
});

app.patch('/api/tickets/:id', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  for (const k of ['title', 'description', 'workspace', 'overrides', 'humanTest', 'scheduledAt']) {
    if (k in req.body) t[k] = req.body[k];
  }
  store.saveTicket(t.id);
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.delete('/api/tickets/:id', (req, res) => {
  runner.stop(req.params.id);
  store.deleteTicket(req.params.id);
  broadcast({ type: 'state-changed' });
  res.json({ ok: true });
});

app.post('/api/tickets/:id/move', (req, res) => {
  const t = runner.moveTicket(req.params.id, req.body.columnId, { by: 'human', autoRun: req.body.autoRun ?? null });
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/tickets/:id/comment', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  store.appendActivity(t.id, { kind: 'comment', by: 'human', text: String(req.body.text || '').trim() });
  // A human comment on a parked ticket is an answer — wake the agent to act on it.
  const col = store.column(t.columnId);
  const h = store.effectiveHarness(t, col);
  let woke = false;
  if (col?.role === 'agent' && h.type !== 'human' && ['idle', 'awaiting-human', 'error'].includes(t.status)) {
    woke = runner.enqueue(t.id, { by: 'engine' });
  }
  broadcast({ type: 'state-changed' });
  res.json({ ...t, woke });
});

app.post('/api/tickets/:id/run', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const col = store.column(t.columnId);
  const h = store.effectiveHarness(t, col);
  // RUN from a human column means "start the pipeline": advance to the next agent phase.
  if (h.type === 'human') {
    const next = store.nextAgentColumn(col.id);
    if (!next) return res.json({ queued: false, reason: `no agent phase after ${col.name}` });
    runner.moveTicket(t.id, next.id, { by: 'human', autoRun: true });
    return res.json({ queued: true, startedPhase: next.name });
  }
  const ok = runner.enqueue(t.id, { by: 'human' });
  res.json({ queued: ok, reason: ok ? null : 'already queued or running' });
});

app.post('/api/tickets/:id/stop', (req, res) => {
  runner.stop(req.params.id);
  res.json({ ok: true });
});

app.get('/api/tickets/:id/dossier', (req, res) => {
  res.type('text/plain').send(store.readDossier(req.params.id));
});

app.get('/api/tickets/:id/transcript', (req, res) => {
  const dir = store.transcriptsDir(req.params.id);
  try {
    const files = fs.readdirSync(dir).sort();
    const file = req.query.file ? path.basename(String(req.query.file)) : files[files.length - 1];
    if (!file) return res.json({ files: [], lines: [] });
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).slice(-500);
    res.json({ files, file, lines });
  } catch {
    res.json({ files: [], lines: [] });
  }
});

// ---- columns / board ----
app.post('/api/columns', (req, res) => {
  const col = {
    id: `col-${crypto.randomBytes(4).toString('hex')}`,
    name: req.body.name || 'New Phase',
    order: store.board.columns.length,
    role: req.body.role || 'agent',
    harness: req.body.harness || { type: 'claude', model: 'claude-sonnet-5', effort: 'high', permissions: 'auto' },
    phasePrompt: req.body.phasePrompt || '',
    autoRun: req.body.autoRun ?? false,
    exitCriteria: req.body.exitCriteria || '',
  };
  store.board.columns.push(col);
  store.saveBoard();
  broadcast({ type: 'state-changed' });
  res.json(col);
});

app.patch('/api/columns/:id', (req, res) => {
  const col = store.column(req.params.id);
  if (!col) return res.status(404).json({ error: 'not found' });
  for (const k of ['name', 'role', 'harness', 'phasePrompt', 'autoRun', 'exitCriteria', 'order']) {
    if (k in req.body) col[k] = req.body[k];
  }
  store.saveBoard();
  broadcast({ type: 'state-changed' });
  res.json(col);
});

app.delete('/api/columns/:id', (req, res) => {
  const col = store.column(req.params.id);
  if (!col) return res.status(404).json({ error: 'not found' });
  const occupied = [...store.tickets.values()].some((t) => t.columnId === col.id);
  if (occupied) return res.status(400).json({ error: 'column has tickets' });
  store.board.columns = store.board.columns.filter((c) => c.id !== col.id);
  store.saveBoard();
  broadcast({ type: 'state-changed' });
  res.json({ ok: true });
});

app.patch('/api/settings', (req, res) => {
  Object.assign(store.board.settings, req.body);
  store.saveBoard();
  broadcast({ type: 'state-changed' });
  res.json(store.board.settings);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dispatch listening on http://0.0.0.0:${PORT}`);
});
