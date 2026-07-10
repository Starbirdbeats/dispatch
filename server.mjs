// server.mjs — Dispatch: kanban OS for multi-harness agent work.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Store, DATA_DIR } from './store.mjs';
import { Runner } from './engine/runner.mjs';
import { REGISTRY, loadCodexDefaults, loadModelsCache, refreshModels, probe } from './registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DISPATCH_PORT || 4400);

const BOOT_ID = crypto.randomUUID(); // stale open tabs self-reload when this changes
const store = new Store();
loadCodexDefaults();
loadModelsCache(); // merge any previously-refreshed model list
let health = { claude: { ok: false }, codex: { ok: false } };
probe().then((h) => { health = h; broadcast({ type: 'state-changed' }); });

const app = express();
// Attachments ride in as base64 on the ticket JSON, so the body limit must clear the
// per-file cap plus base64's ~33% inflation and room for a few files at once.
const MAX_ATTACH_MB = 16;
app.use(express.json({ limit: '48mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Validate an incoming attachment list ([{name, type, dataB64}]). Returns {ok, files?, error?, status?}.
function checkAttachments(list) {
  if (list == null) return { ok: true, files: [] };
  if (!Array.isArray(list)) return { ok: false, status: 400, error: 'attachments must be an array' };
  for (const f of list) {
    if (!f || typeof f.name !== 'string' || typeof f.dataB64 !== 'string') {
      return { ok: false, status: 400, error: 'each attachment needs a name and dataB64' };
    }
    if (Buffer.byteLength(f.dataB64, 'base64') > MAX_ATTACH_MB * 1024 * 1024) {
      return { ok: false, status: 413, error: `${f.name} exceeds the ${MAX_ATTACH_MB}MB limit` };
    }
  }
  return { ok: true, files: list };
}

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
// maxConcurrent === 0 is the engine pause switch: nothing new starts, and the auto-schedulers
// go quiet so the queue/log don't churn while paused.
const isPaused = () => (store.board.settings.maxConcurrent ?? 2) <= 0;
function autoDispatchTick() {
  const s = store.board.settings;
  if (s.autoDispatch === false || isPaused()) return;
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
    const next = store.nextAgentColumn(col.id, t);
    if (!next) continue;
    store.appendActivity(t.id, {
      kind: 'system', by: 'engine',
      text: t.scheduledAt ? `auto-dispatch: scheduled time ${t.scheduledAt} reached` : 'auto-dispatch: backlog sweep',
    });
    if (t.scheduledAt) { t.scheduledAt = null; store.saveTicket(t.id); } // no refire if it ever returns
    runner.moveTicket(t.id, next.id, { by: 'engine', autoRun: true });
  }
  // Rate-limited runs parked with a retryAt: resume them once the window resets.
  for (const t of store.tickets.values()) {
    if (!t.retryAt || now < t.retryAt) continue;
    const col = store.column(t.columnId);
    delete t.retryAt;
    store.saveTicket(t.id);
    if (col?.role === 'agent' && t.status === 'error') {
      store.appendActivity(t.id, { kind: 'system', by: 'engine', text: 'rate-limit window reset — retrying run' });
      t.status = 'idle';
      runner.enqueue(t.id, { by: 'engine' });
    }
  }

  // Even a no-op sweep advances nextSweepAt — push it so client countdowns reset.
  if (sweep) broadcast({ type: 'state-changed' });
}
// ---- stall watchdog ----
// Every tick, inspect agent columns that HAVE tickets and resume orphaned work — tickets
// that sat idle/errored past the dwell threshold with no live run behind them.
// Never intervenes while an agent is actually working (engine entry or live pid = hands off).
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function stallWatchdogTick(now) {
  const s = store.board.settings;
  if (isPaused()) return; // engine paused — don't resume anything
  const stallMs = (s.stallAfterMin ?? 10) * 60_000;
  if (stallMs <= 0) return; // 0 disables the watchdog
  const snap = runner.snapshot();
  const busy = new Set([...snap.running, ...snap.queued]);

  for (const col of store.board.columns) {
    if (col.role !== 'agent' || !col.autoRun) continue; // manual columns stay manual
    const tickets = [...store.tickets.values()].filter((t) => t.columnId === col.id);
    if (!tickets.length) continue; // empty column: skip inspection entirely

    for (const t of tickets) {
      if (busy.has(t.id)) continue;                                 // engine is on it
      if (t.activeRun?.pid && pidAlive(t.activeRun.pid)) continue;  // agent process genuinely alive
      if (t.status === 'awaiting-human') continue;                  // deliberately parked for Marcello
      if (t.retryAt) continue;                                      // rate-limit retry already scheduled
      if (t.pendingWake) continue;                                  // a comment wake is already counting down
      const since = Date.parse(t.enteredColumnAt || t.lastRunEndedAt || t.createdAt);
      if (!Number.isFinite(since) || now - since < stallMs) continue;
      if (t.status === 'error') {
        if ((t.watchdogRetries || 0) >= 2) continue;                // hard failure: leave it visible
        t.watchdogRetries = (t.watchdogRetries || 0) + 1;
      }
      const dwellMin = Math.round((now - since) / 60_000);
      store.appendActivity(t.id, {
        kind: 'system', by: 'engine',
        text: `stall watchdog: ${t.status} in ${col.name} for ${dwellMin} min with no live run — resuming`,
      });
      t.status = 'idle';
      // dwell clock restarts so the watchdog doesn't hammer the same ticket every tick
      t.enteredColumnAt = new Date(now).toISOString();
      store.saveTicket(t.id);
      runner.enqueue(t.id, { by: 'engine' });
    }
  }
}

// ---- comment-wake processor ----
// A comment on a parked ticket schedules a wake ~60s out (grace window to keep typing / cancel).
// Runs on a fast cadence so the countdown the UI shows is accurate. Fires only when the ticket
// is idle — if a run is in progress, the wake waits and fires the moment it frees up.
const WAKE_DELAY_MS = 60_000;
function processPendingWakes(now) {
  if (isPaused()) return; // hold wakes until the engine resumes
  for (const t of store.tickets.values()) {
    const pw = t.pendingWake;
    if (!pw || now < pw.at) continue;
    if (t.activeRun || runner.snapshot().running.includes(t.id) || runner.snapshot().queued.includes(t.id)) continue;
    const col = store.column(t.columnId);
    if (!col || col.role !== 'agent') { delete t.pendingWake; store.saveTicket(t.id); continue; }
    if (pw.harness) t.oneShotHarness = pw.harness; // one-shot: steer who picks it up
    delete t.pendingWake;
    t.status = 'idle';
    store.appendActivity(t.id, { kind: 'system', by: 'engine', text: 'comment wake fired — starting run' });
    runner.enqueue(t.id, { by: 'human' });
  }
}

setInterval(() => {
  try { autoDispatchTick(); } catch (e) { console.error('auto-dispatch:', e); }
  try { stallWatchdogTick(Date.now()); } catch (e) { console.error('stall-watchdog:', e); }
}, TICK_MS);

setInterval(() => {
  try { processPendingWakes(Date.now()); } catch (e) { console.error('pending-wake:', e); }
}, 5_000);

// ---- disk retention ----
// Prune agent scratch + trim run journals across all tickets that aren't actively being worked.
function pruneSweep() {
  const snap = runner.snapshot();
  const busy = new Set([...snap.running, ...snap.queued]);
  const keepRuns = store.board.settings.keepRunsPerTicket ?? 5;
  let items = 0;
  for (const t of store.tickets.values()) {
    if (busy.has(t.id) || (t.activeRun?.pid && pidAlive(t.activeRun.pid))) continue; // never touch live work
    items += store.pruneTicketData(t.id, { keepRuns }).removed.length;
  }
  return items;
}
function dataDirBytes() {
  return new Promise((resolve) => {
    execFile('du', ['-sb', DATA_DIR], { timeout: 30_000 }, (err, out) => resolve(err ? null : parseInt(out, 10) || 0));
  });
}
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000; // every 6h, plus on archive/delete
setInterval(() => { try { pruneSweep(); } catch (e) { console.error('prune-sweep:', e); } }, PRUNE_EVERY_MS);

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
  const { title, description, workspace, columnId, overrides, scheduledAt, attachments, readOnly, skip } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const att = checkAttachments(attachments);
  if (!att.ok) return res.status(att.status).json({ error: att.error });
  const t = store.createTicket({ title: title.trim(), description, workspace, columnId, overrides, scheduledAt, attachments: att.files, readOnly, skip });
  broadcast({ type: 'state-changed' });

  const col = store.column(t.columnId);
  const cap = store.board.settings.maxConcurrent ?? 2; // 0 = paused → no free slot
  const freeSlot = runner.snapshot().running.length < cap;
  let started = null;
  if (col?.role === 'agent' && col.autoRun) {
    runner.enqueue(t.id, { by: 'human' });
    started = col.name;
  } else if (col?.role === 'intake' && !t.scheduledAt && freeSlot) {
    // A free run slot and no scheduled time → don't make the human wait for the 5-min sweep;
    // dispatch into the pipeline now. If at capacity, leave it for the sweep as before.
    const next = store.nextAgentColumn(col.id, t);
    if (next) { runner.moveTicket(t.id, next.id, { by: 'human', autoRun: true }); started = next.name; }
  }
  res.json({ ...t, started });
});

app.patch('/api/tickets/:id', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  for (const k of ['title', 'description', 'workspace', 'overrides', 'humanTest', 'scheduledAt', 'readOnly', 'skip']) {
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
  // Moving a ticket puts it back in play — it must not stay hidden in the archive.
  if (t.archived) { delete t.archived; delete t.archivedAt; store.saveTicket(t.id); }
  res.json(t);
});

// Archive is a soft flag: the ticket keeps its column, dossier, and transcripts but drops
// off the board. Only completed work (terminal column) can be archived.
app.post('/api/tickets/:id/archive', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const col = store.column(t.columnId);
  if (col?.role !== 'terminal') return res.status(400).json({ error: 'only completed (terminal) tickets can be archived' });
  t.archived = true;
  t.archivedAt = new Date().toISOString();
  // reclaim scratch + trim run journals now that it's done being worked
  const { removed } = store.pruneTicketData(t.id, { keepRuns: store.board.settings.keepRunsPerTicket ?? 5 });
  if (removed.length) store.appendActivity(t.id, { kind: 'system', by: 'engine', text: `pruned on archive: removed ${removed.length} scratch item(s) — ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? '…' : ''}` });
  store.appendActivity(t.id, { kind: 'system', by: 'human', text: 'archived' });
  store.saveTicket(t.id);
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.post('/api/tickets/:id/unarchive', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  delete t.archived;
  delete t.archivedAt;
  store.appendActivity(t.id, { kind: 'system', by: 'human', text: 'restored from archive' });
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.post('/api/tickets/:id/comment', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty comment' });
  store.appendActivity(t.id, { kind: 'comment', by: 'human', text });

  // A comment on a parked ticket is an answer. Schedule a wake ~60s out (visible countdown,
  // cancellable) rather than firing instantly, and let the human pick which harness picks it up.
  const col = store.column(t.columnId);
  const running = t.status === 'running' || t.activeRun || runner.snapshot().running.includes(t.id) || runner.snapshot().queued.includes(t.id);
  let scheduled = false;
  if (col?.role === 'agent' && !running) {
    const wh = normalizeHarnessOverride(req.body.wakeHarness);
    t.pendingWake = { at: Date.now() + WAKE_DELAY_MS, harness: wh, by: 'human' };
    store.saveTicket(t.id);
    scheduled = true;
  }
  broadcast({ type: 'state-changed' });
  res.json({ scheduled, running: Boolean(running), wakeAt: t.pendingWake?.at || null });
});

// pull only the harness fields we allow to be overridden from the comment composer
function normalizeHarnessOverride(h) {
  if (!h || typeof h !== 'object') return null;
  const out = {};
  for (const k of ['type', 'model', 'effort']) if (h[k]) out[k] = String(h[k]);
  return Object.keys(out).length ? out : null;
}

app.post('/api/tickets/:id/wake-now', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.pendingWake) { t.pendingWake.at = 0; store.saveTicket(t.id); broadcast({ type: 'state-changed' }); }
  res.json({ ok: Boolean(t.pendingWake) });
});

app.post('/api/tickets/:id/cancel-wake', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.pendingWake) { delete t.pendingWake; store.saveTicket(t.id); broadcast({ type: 'state-changed' }); }
  res.json({ ok: true });
});

app.post('/api/tickets/:id/run', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const col = store.column(t.columnId);
  const h = store.effectiveHarness(t, col);
  // RUN from a human column means "start the pipeline": advance to the next agent phase.
  if (h.type === 'human') {
    const next = store.nextAgentColumn(col.id, t);
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

// ---- attachments ----
app.post('/api/tickets/:id/attachments', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const list = Array.isArray(req.body) ? req.body
    : Array.isArray(req.body.attachments) ? req.body.attachments : [req.body];
  const att = checkAttachments(list);
  if (!att.ok) return res.status(att.status).json({ error: att.error });
  const added = att.files.map((f) => store.addAttachment(t.id, f)).filter(Boolean);
  store.appendActivity(t.id, { kind: 'system', by: 'human', text: `attached ${added.length} file(s): ${added.map((a) => a.name).join(', ')}` });
  broadcast({ type: 'state-changed' });
  res.json({ added, attachments: t.attachments });
});

app.delete('/api/tickets/:id/attachments/:attId', (req, res) => {
  const r = store.resolveAttachment(req.params.id, req.params.attId);
  const ok = store.removeAttachment(req.params.id, req.params.attId);
  if (!ok) return res.status(404).json({ error: 'not found' });
  store.appendActivity(req.params.id, { kind: 'system', by: 'human', text: `removed attachment: ${r?.meta.name || req.params.attId}` });
  broadcast({ type: 'state-changed' });
  res.json({ ok: true });
});

app.get('/api/tickets/:id/attachments/:attId', (req, res) => {
  const r = store.resolveAttachment(req.params.id, req.params.attId);
  if (!r || !fs.existsSync(r.path)) return res.status(404).json({ error: 'not found' });
  if (r.meta.type) res.type(r.meta.type);
  const safe = r.meta.name.replace(/["\r\n]/g, "'");
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${safe}"`);
  res.sendFile(r.path);
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
  runner.pump(); // raising the cap (or un-pausing) should drain any queued work immediately
  broadcast({ type: 'state-changed' });
  res.json(store.board.settings);
});

// refresh the model dropdowns from the providers' official model docs
app.post('/api/models/refresh', async (_req, res) => {
  try {
    const summary = await refreshModels();
    broadcast({ type: 'state-changed' });
    res.json({ registry: REGISTRY, ...summary });
  } catch (e) {
    res.status(502).json({ error: `model refresh failed: ${e.message}` });
  }
});

// current on-disk footprint of the data dir
app.get('/api/maintenance/usage', async (_req, res) => {
  res.json({ bytes: await dataDirBytes() });
});

// prune scratch + trim run journals across idle tickets, report space reclaimed
app.post('/api/maintenance/prune', async (_req, res) => {
  const before = await dataDirBytes();
  const items = pruneSweep();
  const after = await dataDirBytes();
  broadcast({ type: 'state-changed' });
  res.json({ ticketsScanned: store.tickets.size, itemsRemoved: items, before, after, freedBytes: before != null && after != null ? Math.max(0, before - after) : null });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dispatch listening on http://0.0.0.0:${PORT}`);
});
