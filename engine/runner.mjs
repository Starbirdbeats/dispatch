// runner.mjs — the run engine: queue, spawn, stream, enforce the hand-off contract.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { composePrompt, parseControlBlock } from './contract.mjs';

const ADAPTERS = { claude, codex };
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

export class Runner {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.queue = [];
    this.running = new Map(); // ticketId -> { runId, pollTimer, transcript, readOffset, buf }
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
    return { ...this.store.effectiveHarness(ticket, column), ...(ticket.oneShotHarness || {}) };
  }

  enqueue(ticketId, { by = 'engine' } = {}) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return false;
    const column = this.store.column(ticket.columnId);
    if (!column) return false;
    const harness = this.harnessFor(ticket, column);
    if (harness.type === 'human') return false;
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
    if (column.role === 'terminal' && !ticket.humanTest && by !== 'human') {
      ticket.status = 'awaiting-human';
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `blocked from entering ${column.name}: no human_test provided` });
      this.store.saveTicket(ticketId);
      this.broadcast({ type: 'state-changed' });
      return ticket;
    }

    ticket.columnId = columnId;
    ticket.enteredColumnAt = new Date().toISOString();
    delete ticket.watchdogRetries; // fresh phase, fresh watchdog budget
    delete ticket.holds;           // hold counter is per column visit
    delete ticket.stuckReason;     // whatever stuck it is left behind
    delete ticket.pendingWake;
    if (by === 'human') ticket.bounces = 0;
    if (ticket.status !== 'running') ticket.status = 'idle';
    this.store.appendActivity(ticketId, { kind: 'move', by, text: `${from?.name || '?'} → ${column.name}` });
    this.store.saveTicket(ticketId);

    const shouldRun = autoRun ?? column.autoRun;
    if (shouldRun && column.role === 'agent') this.enqueue(ticketId, { by });
    this.broadcast({ type: 'state-changed' });
    return ticket;
  }

  _saveQueue() {
    this.store.saveQueue(this.queue);
  }

  _pump() {
    const cap = this.store.board.settings.maxConcurrent || 2;
    while (this.running.size < cap && this.queue.length) {
      const job = this.queue.shift();
      this._saveQueue();
      this._run(job).catch((err) => {
        const t = this.store.tickets.get(job.ticketId);
        if (t) {
          t.status = 'error';
          delete t.activeRun;
          delete t.currentRun;
          this.store.saveTicket(t.id);
        }
        this.store.appendActivity(job.ticketId, { kind: 'system', by: 'engine', text: `runner crash: ${err.message}` });
        this._closeEntry(job.ticketId);
        this.broadcast({ type: 'state-changed' });
        this._pump();
      });
    }
  }

  async _run({ ticketId }) {
    const store = this.store;
    const ticket = store.tickets.get(ticketId);
    if (!ticket) return;
    if (ticket.activeRun) { this._attach(ticketId); return; }
    const column = store.column(ticket.columnId);
    if (!column) throw new Error(`column missing: ${ticket.columnId}`);
    const harness = this.harnessFor(ticket, column);
    if (ticket.oneShotHarness) { delete ticket.oneShotHarness; store.saveTicket(ticketId); }
    const adapter = ADAPTERS[harness.type];
    if (!adapter) throw new Error(`unknown harness ${harness.type}`);
    if (!fs.existsSync(ticket.workspace)) throw new Error(`workspace missing: ${ticket.workspace}`);

    const dataDir = store.ticketDir(ticketId);
    const sessionId = ticket.sessions[harness.type];
    const sinceLastRun = ticket.lastRunEndedAt || ticket.createdAt;
    const recentActivity = ticket.activity
      .filter((a) => a.ts > sinceLastRun && (a.kind === 'comment' || a.kind === 'handoff'))
      .slice(-10);

    const prompt = composePrompt({
      ticket, column, harness,
      dossierPath: store.dossierPath(ticketId),
      recentActivity,
      resume: Boolean(sessionId),
    });

    const inv = adapter.buildInvocation({ prompt, harness, sessionId, dataDir, workspace: ticket.workspace });
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
      cwd: ticket.workspace,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();

    const activeRun = {
      runId, pid: proc.pid, pgid: proc.pid, columnId: column.id,
      harnessType: harness.type, model: harness.model, effort: harness.effort,
      startedAt, deadlineAt, transcriptFile,
      lastMsgFile: inv.lastMsgFile || null,
      newSessionId: inv.newSessionId || null,
      killIntent: null,
    };
    atomicWrite(path.join(runDir, 'cmd.json'), JSON.stringify({
      runId, ticketId, columnId: column.id,
      harness: { type: harness.type, model: harness.model, effort: harness.effort },
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
    delete ticket.stuckReason;   // fresh run — clear whatever stuck the last attempt
    delete ticket.pendingWake;   // this run IS the wake
    ticket.currentRun = { column: column.name, harness: harness.type, model: harness.model, startedAt, transcriptFile };
    ticket.activeRun = activeRun;
    store.saveTicket(ticketId);
    store.appendActivity(ticketId, { kind: 'run', by: harness.type, text: `run started: ${column.name} (${harness.model || 'default model'}, effort ${harness.effort || 'default'})` });
    this.broadcast({ type: 'state-changed' });

    this._attach(ticketId);
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
      while (idx !== -1) {
        const lineEnd = fileStart + idx + 1;
        const line = data.subarray(pos, idx).toString('utf8');
        const publish = lineEnd > entry.committedOffset;
        this._consumeLine(ticketId, entry, line, publish);
        if (publish) entry.committedOffset = lineEnd;
        pos = idx + 1;
        idx = data.indexOf(10, pos);
      }
      entry.buf = data.subarray(pos);
      atomicWrite(path.join(entry.runDir, 'offset'), String(entry.committedOffset));
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
    if (sessionId && harnessType) ticket.sessions[harnessType] = sessionId;
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
    if (sessionId && ar.harnessType) ticket.sessions[ar.harnessType] = sessionId;

    const intent = ar.killIntent;
    delete ticket.activeRun;
    delete ticket.currentRun;
    this._closeEntry(ticketId);

    if (intent === 'stopped') {
      ticket.status = 'idle';
      this.store.appendActivity(ticketId, { kind: 'system', by: 'human', text: 'run stopped' });
    } else if (intent === 'timeout') {
      ticket.status = 'error';
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run timed out after ${this.store.board.settings.runTimeoutMin || 30} min` });
    } else {
      ticket.status = 'idle';
      this.store.saveTicket(ticketId);
      this.store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: 'run was interrupted by a server restart — resuming' });
      this.enqueue(ticketId, { by: 'engine' });
    }

    this.store.saveTicket(ticketId);
    this.broadcast({ type: 'state-changed' });
    this._pump();
  }

  _parkClaimedRun(ticketId) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return;
    delete ticket.activeRun;
    delete ticket.currentRun;
    ticket.status = 'awaiting-human';
    this._closeEntry(ticketId);
    this.store.appendActivity(ticketId, {
      kind: 'system', by: 'engine',
      text: 'finalized but post-run handling may have been lost — check transcript',
    });
    this.store.saveTicket(ticketId);
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
    if (control.human_test) ticket.humanTest = control.human_test;

    switch (control.action) {
      case 'advance': {
        const target = control.target_column ? store.columnByName(control.target_column) : store.nextColumn(column.id);
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
        ticket.bounces = (ticket.bounces || 0) + 1;
        if (!target || ticket.bounces > MAX_BOUNCES) {
          ticket.status = 'awaiting-human';
          ticket.stuckReason = { kind: 'bounce-limit', at: nowIso(), detail: !target ? `The agent tried to bounce to "${control.target_column}", which doesn't exist.` : `This ticket has bounced ${ticket.bounces} times (limit ${MAX_BOUNCES}) — the phases are disagreeing and it needs your call.` };
          store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: !target ? `bounce target "${control.target_column}" not found` : `bounce limit (${MAX_BOUNCES}) hit — needs a human decision` });
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
}
