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

// ---- state ----
app.get('/api/state', (_req, res) => {
  res.json({
    board: store.board,
    tickets: [...store.tickets.values()],
    registry: REGISTRY,
    health,
    runs: runner.snapshot(),
  });
});

app.post('/api/probe', async (_req, res) => {
  health = await probe();
  broadcast({ type: 'state-changed' });
  res.json(health);
});

// ---- tickets ----
app.post('/api/tickets', (req, res) => {
  const { title, description, workspace, columnId, overrides } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const t = store.createTicket({ title: title.trim(), description, workspace, columnId, overrides });
  broadcast({ type: 'state-changed' });
  const col = store.column(t.columnId);
  if (col?.autoRun && col.role === 'agent') runner.enqueue(t.id, { by: 'human' });
  res.json(t);
});

app.patch('/api/tickets/:id', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  for (const k of ['title', 'description', 'workspace', 'overrides', 'humanTest']) {
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
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.post('/api/tickets/:id/run', (req, res) => {
  const ok = runner.enqueue(req.params.id, { by: 'human' });
  res.json({ queued: ok });
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
