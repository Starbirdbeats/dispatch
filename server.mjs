// server.mjs — Dispatch: kanban OS for multi-harness agent work.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import {
  deleteEnvFileValue,
  ensureEnvFile,
  envEntries,
  loadEnvFile,
  upsertEnvFileValue,
  validateEnvKey,
} from './engine/envfile.mjs';
import { AUTH_COMMANDS, createAuthSessions } from './engine/authflow.mjs';
import { applyUpdateWithStrategy, assessMainDivergence, checkUpdateStatus, createGitRunner, formatGitUpdateError, parseAheadBehind, parseStatusChanges } from './engine/update-status.mjs';
import { inspectWorkspaceResolution, inspectWorkspaceStatus, resolveWorkspace } from './engine/workspace-resolution.mjs';
import { removeTicketWorktree } from './engine/branching.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(process.env.DISPATCH_ENV_FILE || path.join(__dirname, '.env'));
const SYSTEM_FILE = path.join(__dirname, 'SYSTEM.md');
const SYSTEM_LIMIT_BYTES = 256 * 1024;

ensureEnvFile(ENV_FILE);
loadEnvFile(ENV_FILE);

const [{ Store, DATA_DIR, providerEnabled, enabledProviders }, { Runner }, notify, usage, registry] = await Promise.all([
  import('./store.mjs'),
  import('./engine/runner.mjs'),
  import('./engine/notify.mjs'),
  import('./engine/usage.mjs'),
  import('./registry.mjs'),
]);
const { telegramConfig, sendTelegram, detectChats } = notify;
const { USAGE, extractCodexRateLimitsSnapshot, loadUsageCache, setProviderUsage, setProviderPlan } = usage;
const { REGISTRY, loadCodexDefaults, loadModelsCache, refreshModels, registryAgeMs, probe, readClaudeOAuthToken, isClaudeOAuthTokenUnavailable } = registry;
const PORT = Number(process.env.DISPATCH_PORT || 4400);

const BOOT_ID = crypto.randomUUID(); // stale open tabs self-reload when this changes
const store = new Store();
loadCodexDefaults();
loadModelsCache(); // merge any previously-refreshed model list
loadUsageCache(); // merge last known account usage windows
let health = {
  claude: { ok: false, installed: false, authenticated: false, version: null, authDetail: '', error: null },
  codex: { ok: false, installed: false, authenticated: false, version: null, authDetail: '', error: null },
};
let updateStatus = { behind: 0, ahead: 0, branch: null, error: null, checkedAt: null };
let updateCheckInFlight = false;
probe().then((h) => { health = h; broadcast({ type: 'state-changed' }); });

// Keep setup status consistent across state refreshes and settings screens.
function setupStatus() {
  const settings = store?.board?.settings || {};
  const providers = {};
  for (const type of ['claude', 'codex']) {
    const h = health[type] || {};
    providers[type] = {
      enabled: providerEnabled(settings, type),
      installed: Boolean(h.installed),
      authenticated: Boolean(h.authenticated),
      version: h.version || null,
      authDetail: h.authDetail || '',
      error: h.error || null,
      ok: Boolean(h.ok),
    };
  }
  // Transient login-session state (in-memory only, never persisted): pending sessions
  // render the code-paste / open-URL row; errors surface the last failed attempt.
  const auth = authSessions.snapshot();
  return {
    providers,
    enabledTypes: enabledProviders(settings),
    completedAt: settings.setup?.completedAt || null,
    lastPreset: settings.setup?.lastPreset || 'manual',
    authPending: auth.pending,
    authErrors: auth.errors,
  };
}

const app = express();
// Attachments ride in as base64 on the ticket JSON, so the body limit must clear the
// per-file cap plus base64's ~33% inflation and room for a few files at once.
const MAX_ATTACH_MB = 16;
app.use(express.json({ limit: '48mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const VALID_PROVIDERS = new Set(['claude', 'codex']);
const VALID_HARNESSES = new Set(['human', 'claude', 'codex']);

function validateProviderState(raw) {
  const providers = {};
  const input = raw || {};
  for (const type of VALID_PROVIDERS) {
    const enabled = input[type]?.enabled;
    if (enabled === undefined) continue;
    if (typeof enabled !== 'boolean') throw new Error(`providers.${type}.enabled must be boolean`);
    providers[type] = { enabled };
  }
  const extra = Object.keys(input).filter((k) => !VALID_PROVIDERS.has(k));
  if (extra.length) throw new Error(`unknown provider(s): ${extra.join(', ')}`);
  return providers;
}

function normalizeHarnessPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type && !VALID_HARNESSES.has(payload.type)) {
    throw new Error(`invalid harness type: ${payload.type}`);
  }
  return payload;
}

function normalizePreset(preset) {
  const value = String(preset || '').trim().toLowerCase();
  return ['both', 'claude only', 'claude', 'codex only', 'codex'].includes(value)
    ? value
    : 'manual';
}

function applyPresetAssignments(preset) {
  const normalized = normalizePreset(preset);
  const agents = store.board.columns.filter((c) => c.role === 'agent');
  if (!agents.length) return;

  const mappedByPreset = {
    both: ['claude', 'codex', 'claude'],
    'claude only': ['claude', 'claude', 'claude'],
    claude: ['claude', 'claude', 'claude'],
    'codex only': ['codex', 'codex', 'codex'],
    codex: ['codex', 'codex', 'codex'],
  }[normalized] || ['claude', 'codex', 'claude'];
  const byId = {
    'col-planning': mappedByPreset[0],
    'col-build': mappedByPreset[1],
    'col-review': mappedByPreset[2],
  };

  const orderedAgents = [...agents].sort((a, b) => a.order - b.order);
  const presetByRole = {
    both: { planning: 'claude', build: 'codex', review: 'claude' },
    'claude only': { planning: 'claude', build: 'claude', review: 'claude' },
    codex: { planning: 'codex', build: 'codex', review: 'codex' },
    'codex only': { planning: 'codex', build: 'codex', review: 'codex' },
    claude: { planning: 'claude', build: 'claude', review: 'claude' },
  }[normalized] || { planning: mappedByPreset[0], build: mappedByPreset[1], review: mappedByPreset[2] };
  const roleOrder = ['col-planning', 'col-build', 'col-review'];
  const byRole = {
    planning: orderedAgents.find((c) => c.id === roleOrder[0]) || orderedAgents[0],
    build: orderedAgents.find((c) => c.id === roleOrder[1]) || orderedAgents[1],
    review: orderedAgents.find((c) => c.id === roleOrder[2]) || orderedAgents[2],
  };

  for (const col of orderedAgents) {
    let next = byId[col.id];
    if (!next) {
      if (col === byRole.planning) next = presetByRole.planning;
      else if (col === byRole.build) next = presetByRole.build;
      else if (col === byRole.review) next = presetByRole.review;
      else next = mappedByPreset[orderedAgents.indexOf(col)] || mappedByPreset[0];
    }
    col.harness = { ...col.harness, type: next };
  }

  if (store.board.settings) {
    store.board.settings.setup = {
      ...(store.board.settings.setup || {}),
      lastPreset: normalized,
      completedAt: new Date().toISOString(),
    };
  }
}

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
const git = createGitRunner(__dirname);

async function refreshUpdateStatus({ forceBroadcast = false } = {}) {
  if (updateCheckInFlight) return updateStatus;
  updateCheckInFlight = true;
  try {
    const next = await checkUpdateStatus({ git });
    const changed = next.behind !== updateStatus.behind
      || next.ahead !== updateStatus.ahead
      || next.state !== updateStatus.state
      || next.error !== updateStatus.error;
    updateStatus = next;
    if (forceBroadcast || changed) broadcast({ type: 'state-changed' });
    return updateStatus;
  } finally {
    updateCheckInFlight = false;
  }
}

refreshUpdateStatus({ forceBroadcast: true }).catch(() => {});
setInterval(() => {
  refreshUpdateStatus().catch(() => {});
}, 5 * 60 * 1000);

function writeTextAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readSystemPrompt() {
  try { return fs.readFileSync(SYSTEM_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function mapClaudeUsageWindow(win) {
  if (!win) return null;
  return {
    usedPct: win.utilization,
    resetsAt: win.resets_at,
  };
}

// Subscription tier for the usage strip ("MAX·OAUTH" / "PLUS·OAUTH"). Both read
// local CLI auth files — display-only, best-effort, never logged.
function readClaudePlan() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    return (creds.claudeAiOauth || creds).subscriptionType || null;
  } catch { return null; }
}
function readCodexPlan() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    const idToken = auth?.tokens?.id_token;
    // decode-only (no verify): we just want the plan claim for display
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload?.['https://api.openai.com/auth']?.chatgpt_plan_type || null;
  } catch { return null; }
}
function refreshProviderPlans() {
  setProviderPlan('claude', readClaudePlan());
  setProviderPlan('codex', readCodexPlan());
}

async function probeClaudeUsage() {
  const at = new Date().toISOString();
  try {
    const token = readClaudeOAuthToken();
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`usage API ${res.status}`);
    const body = await res.json();
    setProviderUsage('claude', {
      fiveHour: mapClaudeUsageWindow(body.five_hour),
      weekly: mapClaudeUsageWindow(body.seven_day),
      at,
      source: 'claude-oauth-usage',
    });
    return USAGE.claude;
  } catch (e) {
    if (isClaudeOAuthTokenUnavailable(e)) {
      setProviderUsage('claude', {
        fiveHour: null,
        weekly: null,
        at,
        source: 'claude-cli-auth',
        note: 'Usage unavailable: Claude auth is handled by the CLI, but Dispatch cannot read an OAuth token for account usage.',
      });
      return USAGE.claude;
    }
    // transient probe failure (e.g. usage API 429): keep the last-known windows like
    // the codex probe does — stale numbers beat a blanked meter.
    setProviderUsage('claude', {
      fiveHour: USAGE.claude.fiveHour,
      weekly: USAGE.claude.weekly,
      at,
      source: 'claude-oauth-usage',
      error: e.message,
    });
    return USAGE.claude;
  }
}

function fetchCodexRateLimits({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: proc.stdout });
    let settled = false;
    let reqId = 1;
    let rateLimitReqId = null;
    let stderr = '';
    const stderrSnippet = () => stderr.replace(/\s+/g, ' ').trim().slice(0, 500);
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const withStderr = (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const snippet = stderrSnippet();
      return new Error(snippet ? `${msg}; stderr: ${snippet}` : msg);
    };
    const rpcErrorMessage = (prefix, error) => {
      const msg = error?.message || JSON.stringify(error) || 'unknown error';
      return `${prefix}: ${msg}`;
    };
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      err ? reject(withStderr(err)) : resolve(val);
    };
    const send = (o) => {
      if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) return false;
      try {
        return proc.stdin.write(JSON.stringify(o) + '\n');
      } catch (err) {
        finish(err);
        return false;
      }
    };
    const timer = setTimeout(() => finish(new Error('app-server timeout')), timeoutMs);
    proc.on('error', (e) => finish(e));
    proc.stdin.on('error', (e) => finish(e));
    proc.on('exit', () => { if (!settled) finish(new Error('app-server exited early')); });
    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        if (msg.error) return finish(new Error(rpcErrorMessage('initialize', msg.error)));
        send({ jsonrpc: '2.0', method: 'initialized' });
        rateLimitReqId = ++reqId;
        send({ jsonrpc: '2.0', id: rateLimitReqId, method: 'account/rateLimits/read' });
      } else if (msg.id === rateLimitReqId) {
        if (msg.error) return finish(new Error(rpcErrorMessage('rateLimits/read', msg.error)));
        finish(null, msg.result);
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'dispatch', title: 'Dispatch', version: '0.1.0' } } });
  });
}

async function probeCodexUsage() {
  const at = new Date().toISOString();
  try {
    const body = await fetchCodexRateLimits();
    const windows = extractCodexRateLimitsSnapshot(body, { at });
    if (!windows.fiveHour && !windows.weekly) throw new Error('rate limits missing');
    setProviderUsage('codex', {
      fiveHour: windows.fiveHour || USAGE.codex.fiveHour,
      weekly: windows.weekly || USAGE.codex.weekly,
      at,
      source: 'codex-app-server',
    });
    return USAGE.codex;
  } catch (e) {
    setProviderUsage('codex', {
      fiveHour: USAGE.codex.fiveHour,
      weekly: USAGE.codex.weekly,
      at,
      source: USAGE.codex.source || 'codex-app-server',
      error: e.message,
    });
    return USAGE.codex;
  }
}

const USAGE_PROBES = { claude: probeClaudeUsage, codex: probeCodexUsage };

function pollUsage(providers = Object.keys(USAGE_PROBES)) {
  refreshProviderPlans();
  return Promise.allSettled(providers.map((p) => USAGE_PROBES[p]()))
    .then(() => broadcast({ type: 'usage-update', usage: USAGE }));
}

pollUsage().catch(() => {});
setInterval(() => { pollUsage().catch(() => {}); }, 5 * 60 * 1000);

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
// Prune agent scratch, worktree build caches, and run journals across idle tickets.
function pruneSweep() {
  const snap = runner.snapshot();
  const busy = new Set([...snap.running, ...snap.queued]);
  const keepRuns = store.board.settings.keepRunsPerTicket ?? 5;
  let items = 0;
  for (const t of store.tickets.values()) {
    if (busy.has(t.id) || (t.activeRun?.pid && pidAlive(t.activeRun.pid))) continue; // never touch live work
    items += store.pruneTicketData(t.id, { keepRuns }).removed.length;
    items += store.pruneTicketWorktree(t.id).removed.length;
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
app.post('/api/update/apply', async (req, res) => {
  try {
    const strategy = req.body?.strategy ?? null;
    if (strategy != null && strategy !== 'stash' && strategy !== 'discard') {
      return res.status(400).json({ error: `unknown update strategy: ${strategy}` });
    }

    try {
      await git(['fetch', '--quiet', 'origin', 'main'], 30_000);
    } catch (e) {
      return res.status(502).json({ error: formatGitUpdateError(e) });
    }

    const behindOut = await git(['rev-list', '--count', 'refs/heads/main..refs/remotes/origin/main']);
    const { behind } = parseAheadBehind(behindOut, '0');
    if (behind <= 0) {
      updateStatus = await checkUpdateStatus({ git });
      broadcast({ type: 'state-changed' });
      return res.json({ ok: true, applied: false, message: 'NO NEW COMMITS TO APPLY' });
    }

    // 'ff' = strictly behind; 'reset' = diverged but every local-only commit already
    // lives on origin as a rebased twin (routine after shipping); 'blocked' = local
    // main holds changes that exist nowhere upstream — only that case is manual.
    const divergence = await assessMainDivergence({ git });
    if (divergence.mode === 'blocked') {
      const n = divergence.uniqueCount;
      return res.status(409).json({
        error: `local main has ${n} commit${n === 1 ? '' : 's'} with changes not on origin/main — push or rebase them first`,
      });
    }

    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
    let localChanges = null;
    if (branch === 'main') {
      const changes = parseStatusChanges(await git(['status', '--porcelain']));
      if (changes.length && !strategy) {
        // Structured 409: the client renders a resolve dialog (stash / discard) from this.
        return res.status(409).json({
          error: 'working tree has uncommitted changes — commit or stash first',
          code: 'dirty-tree',
          root: __dirname,
          branch,
          changeCount: changes.length,
          changes: changes.slice(0, 80),
        });
      }
      ({ localChanges } = await applyUpdateWithStrategy({ git, strategy: changes.length ? strategy : null, mode: divergence.mode }));
    } else if (divergence.mode === 'reset') {
      await git(['branch', '-f', 'main', 'refs/remotes/origin/main'], 30_000);
    } else {
      await git(['fetch', '--quiet', 'origin', 'main:main'], 30_000);
    }

    updateStatus = await checkUpdateStatus({ git });
    broadcast({ type: 'state-changed' });
    res.json({
      ok: true,
      applied: true,
      behind: 0,
      branch,
      restarting: true,
      bootId: BOOT_ID,
      localChanges,
      message: 'local main updated — Dispatch is restarting to run the new code',
    });
    scheduleRestart(`update applied (${behind} commit${behind === 1 ? '' : 's'})`);
  } catch (e) {
    res.status(500).json({ error: e.message || 'update failed' });
  }
});

// ---- self-restart ----
// After an update is applied the running process is stale. Under a supervisor (systemd sets
// INVOCATION_ID; set DISPATCH_SUPERVISED=1 for anything else) we exit non-zero so
// Restart=on-failure brings the new code up. Run bare, we hand off to a detached copy of
// ourselves instead — the listen() retry below covers the port-handover window.
const SUPERVISED = Boolean(process.env.INVOCATION_ID || process.env.DISPATCH_SUPERVISED);
const RESTART_EXIT_CODE = 75;
function scheduleRestart(reason) {
  console.log(`self-restart: ${reason}`);
  broadcast({ type: 'restarting' });
  setTimeout(() => {
    try { authSessions.disposeAll(); } catch { /* exit hook runs it again anyway */ }
    try { server.close(); } catch { /* already closing */ }
    if (SUPERVISED) process.exit(RESTART_EXIT_CODE);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: __dirname,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }, 500); // let the apply response and the ws broadcast flush first
}

// Lightweight liveness probe: the client polls this while the server restarts after an
// update — a changed bootId means the new process is up.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, bootId: BOOT_ID });
});

app.get('/api/state', (_req, res) => {
  res.json({
    board: store.board,
    tickets: [...store.tickets.values()],
    registry: REGISTRY,
    health,
    updateStatus,
    setup: setupStatus(),
    usage: USAGE,
    runs: runner.snapshot(),
    scheduler: {
      autoDispatch: store.board.settings.autoDispatch !== false,
      nextSweepAt,
    },
    serverBoot: BOOT_ID,
  });
});

app.post('/api/probe', async (_req, res) => {
  refreshProviderPlans();
  const [nextHealth] = await Promise.all([probe(), probeClaudeUsage(), probeCodexUsage()]);
  health = nextHealth;
  broadcast({ type: 'state-changed' });
  res.json(health);
});

// On-demand usage re-probe (clicking a provider in the usage strip). Scoped to one
// provider so a Claude refresh doesn't pay for spawning the Codex app-server.
app.post('/api/usage/refresh', async (req, res) => {
  const provider = req.body?.provider;
  if (provider && !Object.hasOwn(USAGE_PROBES, provider)) return res.status(400).json({ error: `unknown provider: ${provider}` });
  await pollUsage(provider ? [provider] : undefined);
  res.json({ usage: USAGE });
});

app.get('/api/setup/status', (_req, res) => {
  res.json(setupStatus());
});

app.patch('/api/setup/providers', (req, res) => {
  try {
    const providers = validateProviderState(req.body?.providers);
    const patch = {
      ...store.board.settings,
      providers: {
        claude: { enabled: true },
        codex: { enabled: true },
        ...(store.board.settings.providers || {}),
        ...providers,
      },
      setup: {
        ...(store.board.settings.setup || {}),
        completedAt: req.body?.completedAt === true ? new Date().toISOString() : (store.board.settings.setup?.completedAt || null),
      },
    };
    if (req.body?.preset) patch.setup.lastPreset = normalizePreset(req.body.preset);
    store.board.settings = patch;
    store.saveBoard();
    runner.pump();
    broadcast({ type: 'state-changed' });
    res.json(setupStatus());
  } catch (e) {
    res.status(400).json({ error: e.message || 'invalid provider config' });
  }
});

app.post('/api/setup/preset', (req, res) => {
  try {
    const preset = normalizePreset(req.body?.preset);
    applyPresetAssignments(preset);
    store.saveBoard();
    runner.pump();
    broadcast({ type: 'state-changed' });
    res.json(setupStatus());
  } catch (e) {
    res.status(400).json({ error: e.message || 'failed to apply preset' });
  }
});

app.post('/api/setup/complete', (_req, res) => {
  store.board.settings = {
    ...store.board.settings,
    setup: {
      ...(store.board.settings.setup || {}),
      completedAt: new Date().toISOString(),
    },
  };
  store.saveBoard();
  broadcast({ type: 'state-changed' });
  res.json(setupStatus());
});

// Subscription OAuth login sessions (claude auth login / codex login). The CLIs run
// headless under systemd, so authflow captures the login URL for the web client to
// open; claude's one-time code comes back through /api/setup/auth/code. When a login
// process settles we re-probe so every connected client flips to AUTHENTICATED.
const authSessions = createAuthSessions({
  onSettled: async () => {
    // Flip auth state fast: re-probe the CLIs and broadcast immediately so the pill
    // updates. Usage meters (network calls) refresh out-of-band — the auth flip must not
    // wait on them.
    try { health = await probe(); } catch { /* keep prior health; pending row still clears */ }
    broadcast({ type: 'state-changed' });
    refreshProviderPlans();
    Promise.all([probeClaudeUsage(), probeCodexUsage()])
      .then(() => broadcast({ type: 'state-changed' }))
      .catch(() => { /* usage is best-effort */ });
  },
});
process.on('exit', () => authSessions.disposeAll());
// systemd stop sends SIGTERM: without a handler node dies without 'exit' hooks, which
// would orphan any pending `claude auth login` / `codex login` children.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { authSessions.disposeAll(); process.exit(0); });
}

// Launch (or return the already-running) login for a provider. Responds with the auth
// URL for the client to open; claude additionally needs the code pasted back.
app.post('/api/setup/auth', async (req, res) => {
  const type = String(req.body?.type || '');
  if (!AUTH_COMMANDS[type]) return res.status(400).json({ error: `unknown provider: ${type || '(none)'}` });
  try {
    const started = await authSessions.start(type);
    broadcast({ type: 'state-changed' }); // other clients render the pending row too
    res.json({ ok: true, host: os.hostname(), ...started });
  } catch (e) {
    broadcast({ type: 'state-changed' });
    res.status(502).json({ error: e.message });
  }
});

// Claude flow: the browser shows a one-time code — forward it to the CLI's stdin.
app.post('/api/setup/auth/code', (req, res) => {
  const type = String(req.body?.type || '');
  if (!AUTH_COMMANDS[type]) return res.status(400).json({ error: `unknown provider: ${type || '(none)'}` });
  try {
    authSessions.submitCode(type, req.body?.code);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/setup/auth/cancel', (req, res) => {
  const type = String(req.body?.type || '');
  if (!AUTH_COMMANDS[type]) return res.status(400).json({ error: `unknown provider: ${type || '(none)'}` });
  const killed = authSessions.cancel(type);
  broadcast({ type: 'state-changed' });
  res.json({ ok: true, cancelled: killed });
});

app.post('/api/notify/test', async (req, res) => {
  const override = {
    telegram: {
      ...(store.board.settings.telegram || {}),
      enabled: true,
      token: req.body?.token || undefined,
      chatId: req.body?.chatId || undefined,
    },
  };
  const cfg = telegramConfig(override);
  if (!cfg.token || !cfg.chatId) {
    return res.status(400).json({ error: 'need a bot token (env TELEGRAM_BOT_TOKEN) and a chat id' });
  }
  try {
    await sendTelegram(cfg, `🔔 Dispatch test — notifications are wired up.\n${cfg.baseUrl}`);
    res.json({ ok: true });
  } catch (e) {
    // "chat not found" = wrong/username-style id, or the human never messaged the bot.
    const hint = /chat not found/i.test(e.message)
      ? ' — telegram can only DM a numeric chat id, and only after you have messaged the bot once. open your bot in telegram, send /start, then hit DETECT CHAT ID.'
      : '';
    res.status(502).json({ error: e.message + hint });
  }
});

// Find the numeric chat id without leaving the browser: the human messages the bot once,
// then this pulls the bot's update backlog and returns every chat it can see.
app.post('/api/notify/detect-chat', async (_req, res) => {
  const cfg = telegramConfig(store.board.settings);
  if (!cfg.token) return res.status(400).json({ error: 'need a bot token (env TELEGRAM_BOT_TOKEN)' });
  try {
    res.json(await detectChats(cfg.token));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/secrets', (_req, res) => {
  try {
    res.json({ path: ENV_FILE, entries: envEntries(ENV_FILE) });
  } catch (e) {
    res.status(500).json({ error: `failed to read secrets: ${e.message}` });
  }
});

app.post('/api/secrets', (req, res) => {
  try {
    const key = validateEnvKey(req.body?.key);
    const value = String(req.body?.value ?? '');
    const entries = upsertEnvFileValue(ENV_FILE, key, value);
    broadcast({ type: 'state-changed' });
    res.json({ path: ENV_FILE, entries });
  } catch (e) {
    res.status(400).json({ error: e.message || 'failed to save secret' });
  }
});

app.delete('/api/secrets/:key', (req, res) => {
  try {
    const key = validateEnvKey(req.params.key);
    const entries = deleteEnvFileValue(ENV_FILE, key);
    broadcast({ type: 'state-changed' });
    res.json({ path: ENV_FILE, entries });
  } catch (e) {
    res.status(400).json({ error: e.message || 'failed to delete secret' });
  }
});

app.get('/api/system-prompt', (_req, res) => {
  try {
    res.json({ path: SYSTEM_FILE, content: readSystemPrompt() });
  } catch (e) {
    res.status(500).json({ error: `failed to read system prompt: ${e.message}` });
  }
});

app.put('/api/system-prompt', (req, res) => {
  try {
    if (typeof req.body?.content !== 'string') return res.status(400).json({ error: 'content required' });
    if (Buffer.byteLength(req.body.content, 'utf8') > SYSTEM_LIMIT_BYTES) {
      return res.status(413).json({ error: 'system prompt is too large' });
    }
    writeTextAtomic(SYSTEM_FILE, req.body.content.endsWith('\n') ? req.body.content : `${req.body.content}\n`);
    broadcast({ type: 'state-changed' });
    res.json({ path: SYSTEM_FILE, content: readSystemPrompt() });
  } catch (e) {
    res.status(500).json({ error: `failed to save system prompt: ${e.message}` });
  }
});

app.get('/api/fs/dirs', (req, res) => {
  const requested = String(req.query.path || store.board.settings.defaultWorkspace || os.homedir());
  const expanded = requested === '~' ? os.homedir() : requested.replace(/^~(?=\/|$)/, os.homedir());
  const target = path.resolve(expanded);
  const parent = path.dirname(target);
  const fallback = fs.existsSync(target) ? target : (fs.existsSync(parent) ? parent : os.homedir());
  try {
    const st = fs.statSync(fallback);
    if (!st.isDirectory()) return res.status(400).json({ error: 'path is not a directory' });
    const dirs = fs.readdirSync(fallback, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 300)
      .map((name) => ({ name, path: path.join(fallback, name) }));
    res.json({
      path: fallback,
      parent: path.dirname(fallback),
      home: os.homedir(),
      defaultWorkspace: store.board.settings.defaultWorkspace,
      dirs,
    });
  } catch (e) {
    res.status(400).json({ error: `cannot read directory: ${e.message}` });
  }
});

app.get('/api/workspace/status', async (req, res) => {
  const raw = String(req.query.path || '').trim();
  if (!raw) return res.status(400).json({ error: 'path required' });
  const expanded = raw === '~' ? os.homedir() : raw.replace(/^~(?=\/|$)/, os.homedir());
  res.json(await inspectWorkspaceStatus(expanded));
});

// Workspace must be an existing directory before a ticket can carry it — a bad path can never
// run (even read-only) and only surfaces at run time otherwise. Dirty/non-git are warnings only.
function checkWorkspace(workspace) {
  const raw = String(workspace ?? store.board.settings.defaultWorkspace ?? '').trim();
  if (!raw) return { error: 'workspace required — pick a folder or set a default workspace in Settings' };
  const expanded = raw === '~' ? os.homedir() : raw.replace(/^~(?=\/|$)/, os.homedir());
  let stat = null;
  try { stat = fs.statSync(expanded); } catch {}
  if (!stat?.isDirectory()) return { error: `workspace is not an existing folder: ${raw}` };
  return { workspace: path.resolve(expanded) };
}

// ---- tickets ----
// Ticket creation is deduped by the client's per-form requestId: if the CREATE request
// gets fired twice (stuck button clicked again, dropped response retried), the replay
// returns the ticket the first request made instead of creating a twin.
const recentTicketCreates = new Map(); // requestId → { ticketId, at }
const TICKET_CREATE_DEDUPE_MS = 10 * 60 * 1000;

app.post('/api/tickets', (req, res) => {
  const { title, description, workspace, columnId, overrides, scheduledAt, attachments, readOnly, skip, maxBounces, requestId } = req.body;
  const reqKey = typeof requestId === 'string' && requestId.length <= 100 ? requestId : '';
  if (reqKey) {
    for (const [k, v] of recentTicketCreates) if (Date.now() - v.at > TICKET_CREATE_DEDUPE_MS) recentTicketCreates.delete(k);
    const prior = recentTicketCreates.get(reqKey);
    const existing = prior && store.tickets.get(prior.ticketId);
    if (existing) return res.json({ ...existing, started: null, deduped: true });
  }
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const ws = checkWorkspace(workspace);
  if (ws.error) return res.status(400).json({ error: ws.error });
  const att = checkAttachments(attachments);
  if (!att.ok) return res.status(att.status).json({ error: att.error });
  const t = store.createTicket({ title: title.trim(), description, workspace: ws.workspace, columnId, overrides, scheduledAt, attachments: att.files, readOnly, skip, maxBounces });
  if (reqKey) recentTicketCreates.set(reqKey, { ticketId: t.id, at: Date.now() });
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
  if ('workspace' in req.body) {
    const ws = checkWorkspace(req.body.workspace);
    if (ws.error) return res.status(400).json({ error: ws.error });
    req.body.workspace = ws.workspace;
  }
  for (const k of ['title', 'description', 'workspace', 'overrides', 'humanTest', 'scheduledAt', 'readOnly', 'skip']) {
    if (k in req.body) t[k] = req.body[k];
  }
  if ('maxBounces' in req.body) {
    const n = req.body.maxBounces;
    t.maxBounces = (n === null || n === '')
      ? null
      : (Number.isFinite(+n) && +n >= 0 ? Math.floor(+n) : t.maxBounces);
  }
  store.saveTicket(t.id);
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.delete('/api/tickets/:id', (req, res) => {
  runner.stop(req.params.id);
  const t = store.tickets.get(req.params.id);
  // The ticket's private worktree dies with the ticket (its branch survives in the repo).
  if (t) {
    try { removeTicketWorktree({ ticket: t, worktreesRoot: store.worktreesRoot() }); } catch { /* best effort */ }
  }
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

app.get('/api/tickets/:id/workspace-resolution', async (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await inspectWorkspaceResolution({ workspace: t.workspace, ticket: t }));
  } catch (e) {
    res.status(409).json({ error: e.message || 'could not inspect workspace' });
  }
});

app.post('/api/tickets/:id/workspace-resolution', async (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  try {
    const result = await resolveWorkspace({
      workspace: t.workspace,
      ticket: t,
      action: String(req.body?.action || ''),
      message: req.body?.message,
    });
    if (result.action !== 'noop') {
      store.appendActivity(t.id, {
        kind: 'system',
        by: 'human',
        text: `resolved workspace blocker by ${result.action === 'commit' ? 'committing' : 'stashing'} ${result.before.changeCount} change(s)`,
      });
    }
    store.saveTicket(t.id);
    broadcast({ type: 'state-changed' });
    res.json(result);
  } catch (e) {
    res.status(409).json({ error: e.message || 'could not resolve workspace' });
  }
});

// Archive is a soft flag: the ticket keeps its column, dossier, and transcripts but drops
// off the board. Archiving is allowed from any phase and removes queued work first.
app.post('/api/tickets/:id/archive', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const wasActive = Boolean(t.activeRun);
  runner.stop(t.id);
  if (t.status === 'queued') t.status = 'idle';
  delete t.pendingWake;
  delete t.retryAt;
  t.archived = true;
  t.archivedAt = new Date().toISOString();
  // Reclaim scratch + trim run journals only once no process is still using the ticket dir.
  if (!wasActive) {
    const { removed } = store.pruneTicketData(t.id, { keepRuns: store.board.settings.keepRunsPerTicket ?? 5 });
    if (removed.length) store.appendActivity(t.id, { kind: 'system', by: 'engine', text: `pruned on archive: removed ${removed.length} scratch item(s) — ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? '…' : ''}` });
  }
  store.appendActivity(t.id, { kind: 'system', by: 'human', text: 'archived' });
  store.saveTicket(t.id);
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.post('/api/tickets/:id/unarchive', (req, res) => {
  let t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const requested = req.body?.columnId ? store.column(req.body.columnId) : null;
  const target = requested || store.board.columns.find((c) => c.role === 'terminal') || store.column(t.columnId);
  if (target && target.id !== t.columnId) {
    t = runner.moveTicket(t.id, target.id, { by: 'human', autoRun: false }) || t;
  }
  delete t.archived;
  delete t.archivedAt;
  delete t.pendingWake;
  delete t.retryAt;
  store.appendActivity(t.id, { kind: 'system', by: 'human', text: `restored from archive${target ? ` to ${target.name}` : ''}` });
  store.saveTicket(t.id);
  broadcast({ type: 'state-changed' });
  res.json(t);
});

app.post('/api/tickets/:id/comment', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty comment' });
  store.appendActivity(t.id, { kind: 'comment', by: 'human', text });

  // A comment in an agent column is an answer. Schedule a wake ~60s out (visible countdown,
  // cancellable) rather than firing instantly, and let the human pick which harness picks it up.
  const col = store.column(t.columnId);
  const running = t.status === 'running' || t.activeRun || runner.snapshot().running.includes(t.id) || runner.snapshot().queued.includes(t.id);
  let scheduled = false;
  if (col?.role === 'agent') {
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

// Skip the wake's grace countdown. Zeroing `at` is enough for a parked ticket, but a
// ticket mid-run is held by the run itself (processPendingWakes waits for it to free up),
// so "now" there means stopping that run — destructive, hence { force: true } only, which
// the UI confirms first. The stopped run finalizes to idle and the wake fires on the next
// pass, comment in hand.
app.post('/api/tickets/:id/wake-now', (req, res) => {
  const t = store.tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!t.pendingWake) return res.json({ ok: false, reason: 'no pending wake' });

  const snap = runner.snapshot();
  const busy = Boolean(t.activeRun) || snap.running.includes(t.id) || snap.queued.includes(t.id);
  if (busy && !req.body?.force) {
    return res.json({ ok: false, running: Boolean(t.activeRun), reason: 'a run is in progress — pass force to stop it and pick up now' });
  }

  t.pendingWake.at = 0;
  store.saveTicket(t.id);
  if (busy) {
    store.appendActivity(t.id, {
      kind: 'system',
      by: 'human',
      text: t.activeRun
        ? 'stopping the current run to pick up the new comment now'
        : 'clearing the queued run to pick up the new comment now',
    });
    runner.stop(t.id); // finalizes to idle; processPendingWakes fires the wake right after
  }
  broadcast({ type: 'state-changed' });
  res.json({ ok: true, stopped: busy });
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
  if (h.type !== 'human' && !store.providerEnabled(h.type)) {
    runner.parkForDisabledProvider(t.id, h.type);
    return res.status(409).json({
      queued: false,
      reason: `${h.type} is disabled in Setup. Open Setup to enable it first.`,
    });
  }
  // RUN from a human column means "start the pipeline": advance to the next agent phase.
  if (h.type === 'human') {
    const next = store.nextAgentColumn(col.id, t);
    if (!next) return res.json({ queued: false, reason: `no agent phase after ${col.name}` });
    runner.moveTicket(t.id, next.id, { by: 'human', autoRun: true });
    return res.json({ queued: true, startedPhase: next.name });
  }
  const ok = runner.enqueue(t.id, { by: 'human' });
  if (ok) return res.json({ queued: true });
  // Already queued: a human hitting RUN again means "start it NOW" — skip the concurrency queue.
  // { force: true } in the body additionally overrides the per-workspace lock (UI confirms first).
  const forced = runner.forceStart(t.id, { ignoreWorkspaceLock: Boolean(req.body?.force) });
  if (forced.started) return res.json({ queued: true, forced: true });
  res.json({
    queued: false,
    workspaceBusy: Boolean(forced.workspaceBusy),
    reason: forced.reason === 'not queued' ? 'already queued or running' : forced.reason,
  });
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
  const harness = normalizeHarnessPayload(req.body?.harness) || { type: 'claude', model: 'claude-sonnet-5', effort: 'high', permissions: 'auto' };
  const col = {
    id: `col-${crypto.randomBytes(4).toString('hex')}`,
    name: req.body.name || 'New Phase',
    order: store.board.columns.length,
    role: req.body.role || 'agent',
    harness,
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
  if (req.body?.harness) {
    const harness = normalizeHarnessPayload(req.body.harness);
    if (!harness) return res.status(400).json({ error: 'invalid harness payload' });
    req.body = { ...req.body, harness };
  }
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
  const body = { ...req.body };
  if ('maxBounces' in body) {
    const n = Number(body.maxBounces);
    body.maxBounces = Number.isFinite(n) && n >= 0 ? Math.floor(n) : (store.board.settings.maxBounces ?? 3);
  }
  Object.assign(store.board.settings, body);
  store.saveBoard();
  runner.pump(); // raising the cap (or un-pausing) should drain any queued work immediately
  broadcast({ type: 'state-changed' });
  res.json(store.board.settings);
});

// refresh the model dropdowns from the providers' official model docs
// Models referenced by column configs or ticket overrides — must survive a refresh even if retired.
function inUseModels() {
  const inUse = { claude: new Set(), codex: new Set() };
  for (const c of store.board.columns) {
    if (c.harness?.model && inUse[c.harness.type]) inUse[c.harness.type].add(c.harness.model);
  }
  for (const t of store.tickets.values()) {
    for (const [colId, o] of Object.entries(t.overrides || {})) {
      const type = o.type || store.column(colId)?.harness?.type;
      if (o.model && inUse[type]) inUse[type].add(o.model);
    }
  }
  return inUse;
}

async function doModelRefresh() {
  const report = await refreshModels({ inUse: inUseModels() });
  broadcast({ type: 'state-changed' });
  return report;
}

app.post('/api/models/refresh', async (_req, res) => {
  try {
    res.json({ registry: REGISTRY, report: await doModelRefresh() });
  } catch (e) {
    res.status(502).json({ error: `model refresh failed: ${e.message}` });
  }
});

// Auto-freshness: refresh at boot when the cache is older than a day, then daily.
const MODELS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
if (registryAgeMs() > MODELS_MAX_AGE_MS) {
  doModelRefresh().then((r) => console.log('model auto-refresh (boot):', JSON.stringify(r))).catch((e) => console.error('model auto-refresh:', e.message));
}
setInterval(() => {
  doModelRefresh().then((r) => console.log('model auto-refresh (daily):', JSON.stringify(r))).catch((e) => console.error('model auto-refresh:', e.message));
}, MODELS_MAX_AGE_MS);

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

// After a self-restart the previous process may hold the port for a moment — retry
// instead of dying, whether we were respawned detached or brought back by systemd.
let listenRetries = 20;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenRetries-- > 0) {
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 500);
    return;
  }
  throw err;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dispatch listening on http://0.0.0.0:${PORT}`);
});
