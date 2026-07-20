// runner.mjs — the run engine: queue, spawn, stream, enforce the hand-off contract.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { composePrompt, parseControlBlock } from './contract.mjs';
import { telegramConfig, sendTelegram, renderMessage } from './notify.mjs';
import { applyCodexRateLimits, USAGE } from './usage.mjs';
import { contextSnapshot } from './limits.mjs';
import { BranchPrepError, isGitWorkTree, prepareTicketBranch } from './branching.mjs';
import { REGISTRY } from '../registry.mjs';

const ADAPTERS = { claude, codex };
const VALID_PERMISSIONS = {
  claude: ['auto', 'acceptEdits', 'manual', 'bypassPermissions'],
  codex: ['read-only', 'workspace-write', 'danger-full-access'],
};
const DEFAULT_PERMISSIONS = {
  claude: 'acceptEdits',
  codex: 'workspace-write',
};
const PROVIDER_MODEL_PREFIX = {
  claude: /^claude-/,
  codex: /^gpt-/,
};
const MAX_BOUNCES = 3;
const MAX_HOLDS = 3; // a phase that holds this many times without advancing is parked for a human
const POLL_MS = 1000;
const KILL_GRACE_MS = 5000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function readOffset(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function truncateArg(a) {
  a = String(a);
  return a.length > 500 ? a.slice(0, 500) + '…' : a;
}

function tailFile(file, n = 800) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.slice(-n);
  } catch {
    return '';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function workspaceKey(workspace) {
  if (!workspace) return '';
  try { return fs.realpathSync(workspace); } catch { return path.resolve(workspace); }
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function normalizeModelAndEffort(h) {
  const reg = REGISTRY[h.type];
  if (!reg) return h;

  const models = reg.models || [];
  const modelKnown = models.some((m) => m.id === h.model);
  const otherProviderModel = Object.entries(PROVIDER_MODEL_PREFIX)
    .some(([type, prefix]) => type !== h.type && prefix.test(h.model || ''));
  if (!h.model || otherProviderModel) h.model = models[0]?.id || '';

  const model = models.find((m) => m.id === h.model);
  const efforts = (model && Array.isArray(model.efforts) && model.efforts.length) ? model.efforts
    : (model && Array.isArray(model.efforts)) ? []
    : (modelKnown || !h.model) ? (reg.efforts || [])
    : null;
  if (efforts && h.effort && !efforts.includes(h.effort)) {
    h.effort = model?.defaultEffort && efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : (efforts[0] || '');
  }
  return h;
}

export class Runner {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.queue = [];
    this.running = new Map(); // ticketId -> { runId, pollTimer, transcript, readOffset, buf }
    this._gitWsCache = new Map(); // workspace realpath -> { git, at } — is-a-git-repo probe cache
  }

  snapshot() {
    return {
      queued: this.queue.map((j) => j.ticketId),
      running: [...this.running.keys()],
    };
  }

  recover() {
    for (const ticket of this.store.tickets.values()) {
      if (!ticket.activeRun) continue;
      const ar = ticket.activeRun;
      const runDir = this.store.runDir(ticket.id, ar.runId);
      if (this._runAlive(ar)) {
        this._attach(ticket.id);
      } else if (exists(path.join(runDir, 'exit.json'))) {
        this._finalize(ticket.id);
      } else if (exists(path.join(runDir, 'finalized.json'))) {
        this._parkClaimedRun(ticket.id);
      } else {
        this._handleDeadRun(ticket.id);
      }
    }

    this.queue = [];
    for (const job of this.store.loadQueue()) {
      const ticket = this.store.tickets.get(job.ticketId);
      if (!ticket || ticket.activeRun || this.running.has(job.ticketId)) continue;
      if (ticket.interrupted) delete ticket.interrupted;
      this.enqueue(job.ticketId, { by: 'engine' });
    }

    for (const ticket of this.store.tickets.values()) {
      if (!ticket.interrupted) continue;
      delete ticket.interrupted;
      const col = this.store.column(ticket.columnId);
      if (col?.role === 'agent') {
        this.store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: 'run was interrupted by a server restart — resuming' });
        this.enqueue(ticket.id, { by: 'engine' });
      } else {
        this.store.saveTicket(ticket.id);
      }
    }
    this._saveQueue();
    this._pump();
  }

  // Effective harness for the next run, honouring a one-shot override (e.g. chosen in the
  // comment composer to steer who picks the ticket up next).
  harnessFor(ticket, column) {
    const h = { ...this.store.effectiveHarness(ticket, column), ...(ticket.oneShotHarness || {}) };
    normalizeModelAndEffort(h);
    const validPerms = VALID_PERMISSIONS[h.type] || [];
    if (validPerms.length && !validPerms.includes(h.permissions)) {
      h.permissions = DEFAULT_PERMISSIONS[h.type];
    }
    // READ-ONLY tickets: force sandbox to look-but-don't-touch, whatever the column configured.
    if (ticket.readOnly && h.type !== 'human') {
      h.permissions = h.type === 'codex' ? 'workspace-write' : 'manual';
      h.readOnly = true;
    }
    return h;
  }

  enqueue(ticketId, { by = 'engine' } = {}) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return false;
    const column = this.store.column(ticket.columnId);
    if (!column) return false;
    const harness = this.harnessFor(ticket, column);
    if (harness.type === 'human') return false;
    if (!this.store.providerEnabled(harness.type)) {
      this._parkDisabledProvider(ticket, harness.type);
      this.broadcast({ type: 'state-changed' });
      return false;
    }
    if (ticket.activeRun || this.running.has(ticketId) || this.queue.some((j) => j.ticketId === ticketId)) return false;

    ticket.status = 'queued';
    this.store.saveTicket(ticketId);
    this.queue.push({ ticketId, columnId: column.id });
    this._saveQueue();
    this.store.appendActivity(ticketId, { kind: 'system', by, text: `queued for ${column.name} (${harness.type} · ${harness.model || 'default'} · ${harness.effort || 'default'})` });
    this.broadcast({ type: 'state-changed' });
    this._pump();
    return true;
  }

  // Force a queued ticket to start immediately, ignoring the concurrency cap.
  // The per-workspace lock only bites for non-git workspaces (git repos get per-ticket
  // worktrees, so they never contend). Even then a human can override it explicitly
  // (ignoreWorkspaceLock) — two runs sharing one plain folder is on them.
  forceStart(ticketId, { ignoreWorkspaceLock = false } = {}) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return { started: false, reason: 'not found' };
    if (ticket.activeRun || this.running.has(ticketId)) return { started: false, reason: 'already running' };
    const idx = this.queue.findIndex((j) => j.ticketId === ticketId);
    if (idx === -1) return { started: false, reason: 'not queued' };
    const workspaceBusy = this._workspaceBusy(ticket.workspace, ticketId);
    if (workspaceBusy && !ignoreWorkspaceLock) {
      return { started: false, workspaceBusy: true, reason: 'another run is active in the same workspace — stop it first or point this ticket at a different workspace' };
    }
    const [job] = this.queue.splice(idx, 1);
    this._saveQueue();
    this.store.appendActivity(ticketId, {
      kind: 'system',
      by: 'human',
      text: workspaceBusy
        ? 'force-started: skipping the concurrency queue AND the workspace lock — another run shares this workspace'
        : 'force-started: skipping the concurrency queue',
    });
    this._launch(job);
    return { started: true };
  }

  parkForDisabledProvider(ticketId, type) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return false;
    const column = this.store.column(ticket.columnId);
    const harness = column ? this.harnessFor(ticket, column) : {};
    const providerType = type || harness.type;
    if (!providerType || providerType === 'human') return false;

    this._parkDisabledProvider(ticket, providerType);
    this.broadcast({ type: 'state-changed' });
    return true;
  }

  _providerDisplayName(type) {
    return type === 'claude' ? 'Claude' : type === 'codex' ? 'Codex' : type;
  }

  _parkDisabledProvider(ticket, type) {
    const msg = `${this._providerDisplayName(type)} is disabled in Settings. Enable it in Setup to run this phase.`;
    ticket.status = 'awaiting-human';
    ticket.stuckReason = { kind: 'provider-disabled', at: nowIso(), detail: msg, provider: type };
    ticket.scheduledAt = ticket.scheduledAt || null;
    this.store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: msg });
    this._maybeNotify(ticket, { by: 'engine' });
    this.store.saveTicket(ticket.id);
  }

  stop(ticketId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((j) => j.ticketId !== ticketId);
    if (this.queue.length !== before) this._saveQueue();

    const ticket = this.store.tickets.get(ticketId);
    if (ticket?.activeRun) {
      this._requestKill(ticket, 'stopped');
      this.broadcast({ type: 'state-changed' });
      return;
    }

    if (ticket && ticket.status === 'queued') {
      ticket.status = 'idle';
      this.store.saveTicket(ticketId);
    }
    this.broadcast({ type: 'state-changed' });
  }

  moveTicket(ticketId, columnId, { by = 'human', autoRun = null } = {}) {
    const ticket = this.store.tickets.get(ticketId);
    const column = this.store.column(columnId);
    if (!ticket || !column) return null;
    const from = this.store.column(ticket.columnId);

    // Done gate: nothing enters a terminal column without human-test instructions.
    // Read-only tickets are exempt — they change nothing, so there's nothing to test.
    if (column.role === 'terminal' && !ticket.humanTest && !ticket.readOnly && by !== 'human') {
      ticket.status = 'awaiting-human';
      ticket.stuckReason = { kind: 'done-gate', at: nowIso(), detail: `Blocked from entering ${column.name}: no human_test was provided.` };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `blocked from entering ${column.name}: no human_test provided` });
      this.store.saveTicket(ticketId);
      this._maybeNotify(ticket);
      this.broadcast({ type: 'state-changed' });
      return ticket;
    }

    ticket.columnId = columnId;
    ticket.enteredColumnAt = new Date().toISOString();
    delete ticket.watchdogRetries; // fresh phase, fresh watchdog budget
    delete ticket.holds;           // hold counter is per column visit
    delete ticket.stuckReason;     // whatever stuck it is left behind
    delete ticket.pendingWake;

    // lifecycle clock: startedAt when work begins, duration is accumulated active time.
    if (column.role === 'agent' && !ticket.startedAt) ticket.startedAt = new Date().toISOString();
    if (column.role === 'terminal') {
      ticket.completedAt = new Date().toISOString();
      this.store.reconcileClock(ticket);
      ticket.durationMs = ticket.startedAt ? ticket.activeMs : null;
    } else if (ticket.completedAt) {
      delete ticket.completedAt; delete ticket.durationMs; // reopened out of Done → clock resumes
    }

    if (by === 'human') ticket.bounces = 0;
    if (ticket.status !== 'running') ticket.status = 'idle';
    this.store.appendActivity(ticketId, { kind: 'move', by, text: `${from?.name || '?'} → ${column.name}` });
    this.store.saveTicket(ticketId);

    const shouldRun = autoRun ?? column.autoRun;
    if (shouldRun && column.role === 'agent') this.enqueue(ticketId, { by });
    this._maybeNotify(ticket, { by });
    this.broadcast({ type: 'state-changed' });
    return ticket;
  }

  _maybeNotify(ticket, { by = 'engine' } = {}) {
    const col = this.store.column(ticket.columnId);
    let event = null;
    let key = null;

    if (col?.role === 'terminal' && ticket.completedAt) {
      if (by === 'human') return;
      event = 'completed';
      key = `done:${ticket.completedAt}`;
    } else if (ticket.status === 'awaiting-human' || (ticket.status === 'error' && !ticket.retryAt)) {
      event = 'intervention';
      key = `stuck:${ticket.stuckReason?.at || ticket.lastRunEndedAt || ticket.enteredColumnAt || ''}`;
    } else {
      return;
    }

    if (!key || key === ticket.lastNotifyKey) return;
    const cfg = telegramConfig(this.store.board.settings);
    if (!cfg.enabled || cfg.events[event] === false) return;

    ticket.lastNotifyKey = key;
    this.store.saveTicket(ticket.id);
    sendTelegram(cfg, renderMessage(event, ticket, col, cfg.baseUrl))
      .catch((e) => this.store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: `telegram notify failed: ${e.message}` }));
  }

  _saveQueue() {
    this.store.saveQueue(this.queue);
  }

  pump() { this._pump(); } // public: call after raising the cap so queued work drains

  _pump() {
    // ?? not || : maxConcurrent === 0 is a real value meaning "paused — start nothing".
    const cap = this.store.board.settings.maxConcurrent ?? 2;
    while (this.running.size < cap && this.queue.length) {
      const jobIndex = this._nextStartableJobIndex();
      if (jobIndex === -1) break;
      const [job] = this.queue.splice(jobIndex, 1);
      this._saveQueue();
      this._launch(job);
    }
  }

  _launch(job) {
    this._run(job).catch((err) => {
      const t = this.store.tickets.get(job.ticketId);
      if (t) {
        t.status = 'error';
        t.stuckReason = { kind: 'runner-crash', at: nowIso(), detail: `The engine crashed while starting the run: ${err.message}` };
        delete t.activeRun;
        delete t.currentRun;
        this.store.saveTicket(t.id);
        this._maybeNotify(t);
      }
      this.store.appendActivity(job.ticketId, { kind: 'system', by: 'engine', text: `runner crash: ${err.message}` });
      this._closeEntry(job.ticketId);
      this.broadcast({ type: 'state-changed' });
      this._pump();
    });
  }

  _nextStartableJobIndex() {
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      const ticket = this.store.tickets.get(job.ticketId);
      if (!ticket) return i;
      if (!this._workspaceBusy(ticket.workspace, ticket.id)) return i;
    }
    return -1;
  }

  _workspaceBusy(workspace, ticketId) {
    // Git workspaces never contend: every write run happens in that ticket's private
    // worktree, so N tickets can target one repo at once. The lock only still matters
    // for non-git workspaces, where runs share the folder itself.
    if (this._isGitWorkspace(workspace)) return false;
    const key = workspaceKey(workspace);
    for (const runningTicketId of this.running.keys()) {
      if (runningTicketId === ticketId) continue;
      const runningTicket = this.store.tickets.get(runningTicketId);
      if (workspaceKey(runningTicket?.workspace) === key) return true;
    }
    return false;
  }

  _isGitWorkspace(workspace) {
    const key = workspaceKey(workspace);
    const hit = this._gitWsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.git;
    let git = false;
    try { git = isGitWorkTree(key); } catch { /* treat as non-git */ }
    this._gitWsCache.set(key, { git, at: Date.now() });
    return git;
  }

  async _run({ ticketId }) {
    const store = this.store;
    const ticket = store.tickets.get(ticketId);
    if (!ticket) return;
    if (ticket.activeRun) { this._attach(ticketId); return; }
    const column = store.column(ticket.columnId);
    if (!column) throw new Error(`column missing: ${ticket.columnId}`);
    const harness = this.harnessFor(ticket, column);
    if (!store.providerEnabled(harness.type)) {
      this._parkDisabledProvider(ticket, harness.type);
      this._closeEntry(ticketId);
      return;
    }
    if (ticket.oneShotHarness) { delete ticket.oneShotHarness; store.saveTicket(ticketId); }
    const adapter = ADAPTERS[harness.type];
    if (!adapter) throw new Error(`unknown harness ${harness.type}`);
    if (!isDirectory(ticket.workspace)) {
      this._parkBranchFailure(ticket, new BranchPrepError(
        'workspace-missing',
        `Workspace folder does not exist or is not a directory: ${ticket.workspace}. Fix the workspace path in the ticket's Overview tab, then retry this phase.`,
      ));
      this._closeEntry(ticketId);
      this.broadcast({ type: 'state-changed' });
      this._pump();
      return;
    }
    let workDir = ticket.workspace;
    let gitDir = null;
    if (!ticket.readOnly) {
      try {
        const prep = this._prepareBranch(ticket);
        if (prep.workDir) workDir = prep.workDir;
        gitDir = prep.gitDir || null;
      } catch (err) {
        if (err instanceof BranchPrepError) {
          this._parkBranchFailure(ticket, err);
          this._closeEntry(ticketId);
          this.broadcast({ type: 'state-changed' });
          this._pump();
          return;
        }
        throw err;
      }
    }

    const dataDir = store.ticketDir(ticketId);
    let sessionId = ticket.sessions[harness.type];
    // Never resume a session minted in a different directory: claude can't find it from a
    // new cwd, and either harness would carry stale absolute paths from the old checkout
    // into the isolated worktree. The dossier carries the context across instead.
    const sessionCwd = ticket.sessionDirs?.[harness.type] || ticket.workspace;
    if (sessionId && sessionCwd !== workDir) {
      sessionId = null;
      store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `starting a fresh ${harness.type} session — the run directory moved to ${workDir}` });
    }
    const sinceLastRun = ticket.lastRunEndedAt || ticket.createdAt;
    const recentActivity = ticket.activity
      .filter((a) => a.ts > sinceLastRun && (a.kind === 'comment' || a.kind === 'handoff'))
      .slice(-10);

    const prompt = composePrompt({
      ticket, column, harness,
      dossierPath: store.dossierPath(ticketId),
      recentActivity,
      resume: Boolean(sessionId),
      workDir,
    });

    const inv = adapter.buildInvocation({ prompt, harness, sessionId, dataDir, workspace: workDir, gitDir });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runId = `${stamp}-${column.name.toLowerCase()}`;
    const runDir = store.runDir(ticketId, runId);
    const transcriptFile = path.join(store.transcriptsDir(ticketId), `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    fs.writeFileSync(transcriptFile, JSON.stringify({ meta: { cmd: inv.cmd, args: inv.args.map(truncateArg), harness, column: column.name } }) + '\n');

    const startedAt = nowIso();
    const deadlineAt = new Date(Date.now() + (store.board.settings.runTimeoutMin || 30) * 60 * 1000).toISOString();
    const wrapper = path.join(__dirname, '..', 'bin', 'dispatch-run.sh');
    if (!fs.existsSync(wrapper)) throw new Error(`wrapper missing: ${wrapper}`);
    const proc = spawn(wrapper, [runDir, '--', inv.cmd, ...inv.args], {
      cwd: inv.cwd || workDir,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();

    const activeRun = {
      runId, pid: proc.pid, pgid: proc.pid, columnId: column.id,
      harnessType: harness.type, model: harness.model, effort: harness.effort,
      workDir,
      startedAt, deadlineAt, transcriptFile,
      lastMsgFile: inv.lastMsgFile || null,
      newSessionId: inv.newSessionId || null,
      killIntent: null,
    };
    atomicWrite(path.join(runDir, 'cmd.json'), JSON.stringify({
      runId, ticketId, columnId: column.id,
      harness: { type: harness.type, model: harness.model, effort: harness.effort },
      branchName: ticket.branchName || null,
      workDir,
      cmd: inv.cmd,
      args: inv.args.map(truncateArg),
      pid: proc.pid,
      pgid: proc.pid,
      startedAt,
      deadlineAt,
      newSessionId: inv.newSessionId || null,
      lastMsgFile: inv.lastMsgFile || null,
      transcriptFile,
    }, null, 2));

    ticket.status = 'running';
    if (!ticket.startedAt) ticket.startedAt = startedAt; // lifecycle clock, if a move didn't set it
    delete ticket.stuckReason;   // fresh run — clear whatever stuck the last attempt
    delete ticket.retryAt;       // manual/fresh runs replace any parked rate-limit retry
    delete ticket.pendingWake;   // this run IS the wake
    ticket.workDir = workDir;
    ticket.currentRun = { column: column.name, harness: harness.type, model: harness.model, branchName: ticket.branchName || null, workDir, startedAt, transcriptFile };
    ticket.activeRun = activeRun;
    store.saveTicket(ticketId);
    store.appendActivity(ticketId, { kind: 'run', by: harness.type, text: `run started: ${column.name} (${harness.model || 'default model'}, effort ${harness.effort || 'default'})` });
    this.broadcast({ type: 'state-changed' });

    this._attach(ticketId);
  }

  _prepareBranch(ticket) {
    let result;
    try {
      const worktreesRoot = typeof this.store.worktreesRoot === 'function' ? this.store.worktreesRoot() : null;
      result = prepareTicketBranch({ ticket, workspace: ticket.workspace, worktreesRoot });
    } catch (err) {
      if (err instanceof BranchPrepError && err.kind === 'workspace-not-git' && isDirectory(ticket.workspace)) {
        const firstBranchless = !ticket.branchless || ticket.branchless.workspace !== ticket.workspace;
        ticket.branchless = {
          kind: 'workspace-not-git',
          workspace: ticket.workspace,
          at: ticket.branchless?.workspace === ticket.workspace ? ticket.branchless.at : nowIso(),
          detail: `Workspace is not a Git work tree: ${ticket.workspace}. Dispatch will run without branch or commit support.`,
        };
        this.store.saveTicket(ticket.id);
        if (firstBranchless) {
          this.store.appendActivity(ticket.id, {
            kind: 'system',
            by: 'engine',
            text: `branch skipped: ${ticket.branchless.detail}`,
          });
        }
        return {
          branchName: null,
          branchBase: null,
          branchedAt: null,
          action: 'skipped-not-git',
        };
      }
      throw err;
    }
    const firstBranch = !ticket.branchName;
    ticket.branchName = result.branchName;
    ticket.branchBase = ticket.branchBase || result.branchBase || null;
    ticket.branchedAt = ticket.branchedAt || result.branchedAt;
    delete ticket.branchless;
    this.store.saveTicket(ticket.id);
    if (firstBranch || result.action === 'worktree-created' || result.action === 'worktree-switched') {
      this.store.appendActivity(ticket.id, {
        kind: 'system',
        by: 'engine',
        text: result.workDir && result.workDir !== ticket.workspace
          ? `branch ready: ${result.branchName} (isolated worktree at ${result.workDir})`
          : `branch ready: ${result.branchName}`,
      });
    }
    if (result.submodules && !result.submodules.ok) {
      this.store.appendActivity(ticket.id, {
        kind: 'system',
        by: 'engine',
        text: `worktree submodules failed to initialize: ${result.submodules.detail || 'unknown error'} — agents may find empty submodule folders`,
      });
    }
    return result;
  }

  _parkBranchFailure(ticket, err) {
    ticket.status = 'awaiting-human';
    ticket.stuckReason = {
      kind: err.kind || 'branch-unavailable',
      at: nowIso(),
      detail: err.detail || err.message || 'Dispatch could not prepare a branch for this ticket.',
    };
    this.store.appendActivity(ticket.id, {
      kind: 'system',
      by: 'engine',
      text: `${err.kind === 'workspace-missing' ? 'workspace check failed' : 'branch prep failed'}: ${ticket.stuckReason.detail}`,
    });
    this._maybeNotify(ticket);
    this.store.saveTicket(ticket.id);
  }

  _attach(ticketId) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket?.activeRun) return null;
    if (this.running.has(ticketId)) return this.running.get(ticketId);
    const entry = this._createEntry(ticket, ticket.activeRun, { poll: true });
    ticket.status = 'running';
    if (!ticket.currentRun) {
      const column = this.store.column(ticket.activeRun.columnId);
      ticket.currentRun = {
        column: column?.name || 'Run',
        harness: ticket.activeRun.harnessType,
        model: ticket.activeRun.model,
        startedAt: ticket.activeRun.startedAt,
        transcriptFile: ticket.activeRun.transcriptFile,
      };
    }
    this.store.saveTicket(ticketId);
    return entry;
  }

  _createEntry(ticket, activeRun, { poll }) {
    const runDir = this.store.runDir(ticket.id, activeRun.runId);
    const cmd = readJSON(path.join(runDir, 'cmd.json'), {});
    const adapter = ADAPTERS[activeRun.harnessType || cmd.harness?.type];
    if (!adapter) return null;
    const transcriptFile = activeRun.transcriptFile || cmd.transcriptFile
      || path.join(this.store.transcriptsDir(ticket.id), `${activeRun.runId}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    const column = this.store.column(activeRun.columnId || cmd.columnId);
    const entry = {
      runId: activeRun.runId,
      runDir,
      adapter,
      columnId: activeRun.columnId || cmd.columnId,
      columnName: column?.name || 'Run',
      transcript: fs.createWriteStream(transcriptFile, { flags: 'a' }),
      state: { sessionId: null, finalText: '', exitInfo: null },
      readOffset: 0,
      committedOffset: exists(path.join(runDir, 'offset')) ? readOffset(path.join(runDir, 'offset')) : 0,
      buf: Buffer.alloc(0),
      pollTimer: null,
      killTimer: null,
      lastContextSig: null,
      lastRateLimitSig: null,
    };
    this.running.set(ticket.id, entry);
    if (poll) {
      entry.pollTimer = setInterval(() => this._poll(ticket.id), POLL_MS);
      this._poll(ticket.id);
    }
    return entry;
  }

  _poll(ticketId) {
    try {
      const ticket = this.store.tickets.get(ticketId);
      const ar = ticket?.activeRun;
      const entry = this.running.get(ticketId);
      if (!ticket || !ar || !entry) { this._closeEntry(ticketId); return; }

      this._drainJournal(ticketId, entry);
      if (exists(path.join(entry.runDir, 'exit.json'))) { this._finalize(ticketId); return; }
      if (!this._runAlive(ar)) { this._handleDeadRun(ticketId); return; }
      if (!ar.killIntent && Date.now() > new Date(ar.deadlineAt).getTime()) {
        this._requestKill(ticket, 'timeout');
      }
    } catch (err) {
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `attach loop error: ${err.message}` });
      this.broadcast({ type: 'state-changed' });
    }
  }

  _drainJournal(ticketId, entry) {
    const file = path.join(entry.runDir, 'events.jsonl');
    if (!exists(file)) return;
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < entry.readOffset) {
        entry.readOffset = 0;
        entry.committedOffset = 0;
        entry.buf = Buffer.alloc(0);
      }
      if (size <= entry.readOffset) return;

      const readFrom = entry.readOffset;
      const fileStart = readFrom - entry.buf.length;
      const chunk = Buffer.alloc(size - readFrom);
      fs.readSync(fd, chunk, 0, chunk.length, readFrom);
      entry.readOffset = size;

      const data = entry.buf.length ? Buffer.concat([entry.buf, chunk]) : chunk;
      let pos = 0;
      let idx = data.indexOf(10, pos);
      let consumedLine = false;
      while (idx !== -1) {
        const lineEnd = fileStart + idx + 1;
        const line = data.subarray(pos, idx).toString('utf8');
        const publish = lineEnd > entry.committedOffset;
        this._consumeLine(ticketId, entry, line, publish);
        if (publish) entry.committedOffset = lineEnd;
        consumedLine = true;
        pos = idx + 1;
        idx = data.indexOf(10, pos);
      }
      entry.buf = data.subarray(pos);
      atomicWrite(path.join(entry.runDir, 'offset'), String(entry.committedOffset));
      if (consumedLine) this._flushLiveTelemetry(ticketId, entry);
    } finally {
      fs.closeSync(fd);
    }
  }

  _consumeLine(ticketId, entry, line, publish) {
    let events = entry.adapter.parseLine(line, entry.state);
    if (!events) {
      if (publish) entry.transcript.write(JSON.stringify({ raw: line.slice(0, 2000) }) + '\n');
      return;
    }
    if (!Array.isArray(events)) events = [events];
    for (const ev of events) {
      if (!publish) continue;
      entry.transcript.write(JSON.stringify({ ev }) + '\n');
      this.broadcast({ type: 'run-event', ticketId, column: entry.columnName, event: ev });
    }
  }

  _flushLiveTelemetry(ticketId, entry) {
    const snap = contextSnapshot(entry.state.usage);
    const sig = snap ? `${snap.pct}|${snap.contextTokens}|${snap.inputTokens ?? ''}|${snap.outputTokens ?? ''}` : null;
    if (snap && sig !== entry.lastContextSig) {
      entry.lastContextSig = sig;
      const ar = this.store.tickets.get(ticketId)?.activeRun;
      this.broadcast({
        type: 'context-update',
        ticketId,
        harnessType: ar?.harnessType,
        runStartedAt: ar?.startedAt || null,
        context: snap,
      });
    }

    const harnessType = this.store.tickets.get(ticketId)?.activeRun?.harnessType;
    if (harnessType === 'codex' && entry.state.rateLimits) {
      const sig = JSON.stringify(entry.state.rateLimits);
      if (sig !== entry.lastRateLimitSig) {
        entry.lastRateLimitSig = sig;
        if (applyCodexRateLimits(entry.state.rateLimits, { at: nowIso(), source: 'codex-stream' })) {
          this.broadcast({ type: 'usage-update', usage: USAGE });
        }
      }
    }
  }

  _finalize(ticketId) {
    const ticket = this.store.tickets.get(ticketId);
    const ar = ticket?.activeRun;
    if (!ticket || !ar) return;
    const runDir = this.store.runDir(ticketId, ar.runId);
    const exitFile = path.join(runDir, 'exit.json');
    const finalizedFile = path.join(runDir, 'finalized.json');
    try {
      fs.renameSync(exitFile, finalizedFile);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    let entry = this.running.get(ticketId);
    if (!entry) entry = this._createEntry(ticket, ar, { poll: false });
    if (entry) this._drainJournal(ticketId, entry);
    const cmd = readJSON(path.join(runDir, 'cmd.json'), {});
    const adapter = entry?.adapter || ADAPTERS[ar.harnessType || cmd.harness?.type];
    const state = adapter ? this._rebuildState(runDir, adapter) : { sessionId: null, finalText: '', exitInfo: null };
    const exitInfo = readJSON(finalizedFile, { code: 1, endedAt: nowIso() }) || { code: 1, endedAt: nowIso() };
    const code = Number(exitInfo.code);
    const intent = ar.killIntent;
    const harnessType = ar.harnessType || cmd.harness?.type;
    let finalText = state.finalText;
    const lastMsgFile = ar.lastMsgFile || cmd.lastMsgFile;
    if (lastMsgFile) {
      try { finalText = fs.readFileSync(lastMsgFile, 'utf8') || finalText; } catch {}
    }

    ticket.lastRunEndedAt = exitInfo.endedAt || nowIso();
    const sessionId = state.sessionId || ar.newSessionId || cmd.newSessionId;
    if (sessionId && harnessType) {
      ticket.sessions[harnessType] = sessionId;
      const runWorkDir = ar.workDir || cmd.workDir;
      if (runWorkDir) ticket.sessionDirs = { ...(ticket.sessionDirs || {}), [harnessType]: runWorkDir };
    }
    const usageSnap = contextSnapshot(state.usage);
    if (usageSnap && harnessType) {
      ticket.context ||= {};
      ticket.context[harnessType] = usageSnap;
      // Per-phase ledger: sum input/output across every run this column has done
      // (retries, holds, bounces back into it), keep the latest context reading.
      const phaseName = this.store.column(ar.columnId || ticket.columnId)?.name;
      if (phaseName) {
        ticket.phaseContext ||= {};
        const prev = ticket.phaseContext[phaseName] || {};
        ticket.phaseContext[phaseName] = {
          ...usageSnap,
          harness: harnessType,
          inputTokens: (prev.inputTokens || 0) + (usageSnap.inputTokens || 0),
          cachedInputTokens: (prev.cachedInputTokens || 0) + (usageSnap.cachedInputTokens || 0),
          outputTokens: (prev.outputTokens || 0) + (usageSnap.outputTokens || 0),
          runs: (prev.runs || 0) + 1,
        };
      }
    }
    if (harnessType === 'codex' && state.rateLimits && applyCodexRateLimits(state.rateLimits, { at: nowIso(), source: 'codex-finalize' })) {
      this.broadcast({ type: 'usage-update', usage: USAGE });
    }
    delete ticket.activeRun;
    delete ticket.currentRun;
    this._closeEntry(ticketId);

    if (intent === 'stopped') {
      ticket.status = 'idle';
      ticket.stuckReason = { kind: 'stopped', at: nowIso(), detail: 'You stopped this run. It will sit idle until you run it again or move it.' };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'human', text: 'run stopped' });
    } else if (intent === 'timeout') {
      ticket.status = 'error';
      ticket.stuckReason = { kind: 'timeout', at: nowIso(), detail: `The run exceeded the ${this.store.board.settings.runTimeoutMin || 30} min timeout and was killed. If the phase legitimately needs longer, raise the timeout in Settings before retrying.` };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run timed out after ${this.store.board.settings.runTimeoutMin || 30} min` });
    } else if (state.rateLimitedUntil && !parseControlBlock(finalText)) {
      // Subscription window exhausted mid-run: park with a retry time; the scheduler resumes it.
      ticket.status = 'error';
      ticket.retryAt = state.rateLimitedUntil + 2 * 60_000;
      ticket.stuckReason = { kind: 'rate-limit', at: nowIso(), detail: `${harnessType}'s subscription window was exhausted mid-run. Auto-retry is scheduled for ${new Date(ticket.retryAt).toLocaleString()} — no action needed.` };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `${harnessType} rate limit hit — auto-retry scheduled for ${new Date(ticket.retryAt).toLocaleString()}` });
    } else if (!Number.isFinite(code) || code !== 0) {
      ticket.status = 'error';
      ticket.stuckReason = { kind: 'run-failed', at: nowIso(), detail: `The ${harnessType} process exited with code ${Number.isFinite(code) ? code : '?'}. stderr: ${tailFile(path.join(runDir, 'stderr.log')).slice(-400) || '(empty)'}` };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run failed (exit ${Number.isFinite(code) ? code : '?'}): ${tailFile(path.join(runDir, 'stderr.log')) || 'no stderr'}` });
    } else {
      this._applyControl(ticket, this.store.column(ar.columnId || ticket.columnId), { type: harnessType, model: ar.model, effort: ar.effort }, parseControlBlock(finalText), finalText);
    }

    this.store.saveTicket(ticketId);
    this._maybeNotify(ticket);
    this.broadcast({ type: 'state-changed' });
    this._pump();
  }

  _handleDeadRun(ticketId) {
    const ticket = this.store.tickets.get(ticketId);
    const ar = ticket?.activeRun;
    if (!ticket || !ar) return;
    const runDir = this.store.runDir(ticketId, ar.runId);
    if (exists(path.join(runDir, 'exit.json'))) { this._finalize(ticketId); return; }
    if (exists(path.join(runDir, 'finalized.json'))) { this._parkClaimedRun(ticketId); return; }

    const entry = this.running.get(ticketId);
    if (entry) this._drainJournal(ticketId, entry);
    const adapter = entry?.adapter || ADAPTERS[ar.harnessType];
    const state = adapter ? this._rebuildState(runDir, adapter) : { sessionId: null };
    const sessionId = state.sessionId || ar.newSessionId;
    if (sessionId && ar.harnessType) {
      ticket.sessions[ar.harnessType] = sessionId;
      if (ar.workDir) ticket.sessionDirs = { ...(ticket.sessionDirs || {}), [ar.harnessType]: ar.workDir };
    }

    const intent = ar.killIntent;
    delete ticket.activeRun;
    delete ticket.currentRun;
    this._closeEntry(ticketId);

    if (intent === 'stopped') {
      ticket.status = 'idle';
      this.store.appendActivity(ticketId, { kind: 'system', by: 'human', text: 'run stopped' });
    } else if (intent === 'timeout') {
      ticket.status = 'error';
      ticket.stuckReason = { kind: 'timeout', at: nowIso(), detail: `The run exceeded the ${this.store.board.settings.runTimeoutMin || 30} min timeout and stopped without a finalized exit record.` };
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run timed out after ${this.store.board.settings.runTimeoutMin || 30} min` });
    } else {
      ticket.status = 'idle';
      this.store.saveTicket(ticketId);
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: 'run was interrupted by a server restart — resuming' });
      this.enqueue(ticketId, { by: 'engine' });
    }

    this.store.saveTicket(ticketId);
    this._maybeNotify(ticket);
    this.broadcast({ type: 'state-changed' });
    this._pump();
  }

  _parkClaimedRun(ticketId) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return;
    delete ticket.activeRun;
    delete ticket.currentRun;
    ticket.status = 'awaiting-human';
    ticket.stuckReason = { kind: 'orphaned-finalize', at: nowIso(), detail: 'The run finalized, but post-run handling may have been lost. Check the transcript before continuing.' };
    this._closeEntry(ticketId);
    this.store.appendActivity(ticketId, {
      kind: 'system', by: 'engine',
      text: 'finalized but post-run handling may have been lost — check transcript',
    });
    this.store.saveTicket(ticketId);
    this._maybeNotify(ticket);
    this.broadcast({ type: 'state-changed' });
    this._pump();
  }

  _rebuildState(runDir, adapter) {
    const state = { sessionId: null, finalText: '', exitInfo: null };
    const file = path.join(runDir, 'events.jsonl');
    if (!exists(file)) return state;
    const data = fs.readFileSync(file);
    let pos = 0;
    let idx = data.indexOf(10, pos);
    while (idx !== -1) {
      adapter.parseLine(data.subarray(pos, idx).toString('utf8'), state);
      pos = idx + 1;
      idx = data.indexOf(10, pos);
    }
    return state;
  }

  _requestKill(ticket, intent) {
    const ar = ticket.activeRun;
    if (!ar) return;
    if (!ar.killIntent) {
      ar.killIntent = intent;
      this.store.saveTicket(ticket.id);
    }
    this._signalGroup(ar, 'SIGTERM');
    const entry = this.running.get(ticket.id);
    if (entry?.killTimer) clearTimeout(entry.killTimer);
    if (entry) entry.killTimer = setTimeout(() => this._signalGroup(ar, 'SIGKILL'), KILL_GRACE_MS);
  }

  _signalGroup(activeRun, signal) {
    const pgid = Number(activeRun.pgid || activeRun.pid);
    if (!pgid) return;
    try { process.kill(-pgid, signal); } catch {}
  }

  _runAlive(activeRun) {
    const pid = Number(activeRun?.pid);
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return cmdline.includes(activeRun.runId);
    } catch {
      return false;
    }
  }

  _closeEntry(ticketId) {
    const entry = this.running.get(ticketId);
    if (!entry) return;
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    try { entry.transcript.end(); } catch {}
    this.running.delete(ticketId);
  }

  _applyControl(ticket, column, harness, control, finalText) {
    const store = this.store;
    if (!column) {
      ticket.status = 'awaiting-human';
      store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: 'run finished but its column no longer exists — needs a human look' });
      return;
    }
    if (!control) {
      ticket.status = 'awaiting-human';
      ticket.stuckReason = { kind: 'no-control-block', at: nowIso(), detail: `The agent's run ended without the required control block, so the engine couldn't tell what to do next. Final output tail: ${String(finalText).slice(-500)}` };
      store.appendActivity(ticket.id, {
        kind: 'system', by: 'engine',
        text: `run finished but no valid control block found — needs a human look. Final output tail: ${String(finalText).slice(-600)}`,
      });
      return;
    }

    store.appendActivity(ticket.id, { kind: 'handoff', by: harness.type, text: control.comment || '(no comment)' });
    this._applyDossierFields(ticket, column, harness, control);
    if (control.human_test) ticket.humanTest = control.human_test;

    switch (control.action) {
      case 'advance': {
        const target = control.target_column ? store.columnByName(control.target_column) : store.nextColumn(column.id, ticket);
        if (!target) {
          ticket.status = 'awaiting-human';
          ticket.stuckReason = { kind: 'no-next-column', at: nowIso(), detail: `The agent wanted to advance${control.target_column ? ` to "${control.target_column}"` : ''} but there is no such next column.` };
          break;
        }
        ticket.status = 'idle';
        this.moveTicket(ticket.id, target.id, { by: harness.type });
        break;
      }
      case 'bounce': {
        const target = store.columnByName(control.target_column);
        const configuredCap = Number.isFinite(ticket.maxBounces) ? ticket.maxBounces : store.board?.settings?.maxBounces;
        const cap = Number.isFinite(configuredCap) && configuredCap >= 0 ? Math.floor(configuredCap) : MAX_BOUNCES;
        ticket.bounces = (ticket.bounces || 0) + 1;
        if (!target || ticket.bounces > cap) {
          ticket.status = 'awaiting-human';
          ticket.stuckReason = { kind: 'bounce-limit', at: nowIso(), detail: !target ? `The agent tried to bounce to "${control.target_column}", which doesn't exist.` : `This ticket has bounced ${ticket.bounces} times (limit ${cap}) — the phases are disagreeing and it needs your call.` };
          store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: !target ? `bounce target "${control.target_column}" not found` : `bounce limit (${cap}) hit — needs a human decision` });
          break;
        }
        ticket.status = 'idle';
        this.moveTicket(ticket.id, target.id, { by: harness.type });
        break;
      }
      case 'flag_human':
        ticket.status = 'awaiting-human';
        ticket.stuckReason = { kind: 'flag-human', at: nowIso(), detail: control.comment || 'The agent flagged that it needs a human decision to continue.' };
        break;
      case 'hold':
      default: {
        // "hold" = did work, phase not complete. Bounded so a phase that can never satisfy its
        // exit criteria (e.g. a deploy that won't come up) parks for a human instead of looping.
        ticket.holds = (ticket.holds || 0) + 1;
        if (ticket.holds >= MAX_HOLDS) {
          ticket.status = 'awaiting-human';
          ticket.stuckReason = { kind: 'hold-limit', at: nowIso(), detail: `${harness.type} finished ${ticket.holds} runs in "${column.name}" without advancing — it keeps doing work but can't meet the exit criteria. Last note: ${control.comment || '(none)'}` };
          store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: `held ${ticket.holds}× in ${column.name} without advancing — parked for a human decision` });
        } else {
          ticket.status = 'idle';
          ticket.stuckReason = { kind: 'hold', at: nowIso(), detail: `${harness.type} did work but held (attempt ${ticket.holds}/${MAX_HOLDS}) — phase not yet complete. Note: ${control.comment || '(none)'}` };
        }
        break;
      }
    }
  }

  _applyDossierFields(ticket, column, harness, control) {
    const store = this.store;
    const workLog = typeof control.work_log === 'string' ? control.work_log.trim() : '';
    if (workLog && typeof store.appendWorkLog === 'function') {
      const header = `### ${nowIso()} — ${harness.type || 'agent'} (${column.name}) [engine-appended]`;
      try {
        store.appendWorkLog(ticket.id, `${header}\n${workLog}`);
      } catch (err) {
        store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: `failed to append work_log to dossier: ${err.message}` });
      }
    }

    const plan = typeof control.plan === 'string' ? control.plan.trim() : '';
    if (plan && typeof store.writePlan === 'function') {
      try {
        store.writePlan(ticket.id, plan);
      } catch (err) {
        store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: `failed to write plan to dossier: ${err.message}` });
      }
    }
  }
}
