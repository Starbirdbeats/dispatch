// runner.mjs — the run engine: queue, spawn, stream, enforce the hand-off contract.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { composePrompt, parseControlBlock } from './contract.mjs';

const ADAPTERS = { claude, codex };
const MAX_BOUNCES = 3;

export class Runner {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.queue = [];
    this.running = new Map(); // ticketId -> { proc, timer, columnId }
  }

  snapshot() {
    return {
      queued: this.queue.map((j) => j.ticketId),
      running: [...this.running.keys()],
    };
  }

  enqueue(ticketId, { by = 'engine' } = {}) {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket) return false;
    const column = this.store.column(ticket.columnId);
    const harness = this.store.effectiveHarness(ticket, column);
    if (!column || harness.type === 'human') return false;
    if (this.running.has(ticketId) || this.queue.some((j) => j.ticketId === ticketId)) return false;

    ticket.status = 'queued';
    this.store.saveTicket(ticketId);
    this.queue.push({ ticketId, columnId: column.id });
    this.store.appendActivity(ticketId, { kind: 'system', by, text: `queued for ${column.name} (${harness.type} · ${harness.model || 'default'} · ${harness.effort || 'default'})` });
    this.broadcast({ type: 'state-changed' });
    this._pump();
    return true;
  }

  stop(ticketId) {
    this.queue = this.queue.filter((j) => j.ticketId !== ticketId);
    const r = this.running.get(ticketId);
    if (r) {
      r.stopped = true;
      r.proc.kill('SIGTERM');
      setTimeout(() => { try { r.proc.kill('SIGKILL'); } catch {} }, 5000);
    } else {
      const t = this.store.tickets.get(ticketId);
      if (t && t.status === 'queued') { t.status = 'idle'; this.store.saveTicket(ticketId); }
      this.broadcast({ type: 'state-changed' });
    }
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
    if (by === 'human') ticket.bounces = 0;
    if (ticket.status !== 'running') ticket.status = 'idle';
    this.store.appendActivity(ticketId, { kind: 'move', by, text: `${from?.name || '?'} → ${column.name}` });
    this.store.saveTicket(ticketId);

    const shouldRun = autoRun ?? column.autoRun;
    if (shouldRun && column.role === 'agent') this.enqueue(ticketId, { by });
    this.broadcast({ type: 'state-changed' });
    return ticket;
  }

  _pump() {
    const cap = this.store.board.settings.maxConcurrent || 2;
    while (this.running.size < cap && this.queue.length) {
      const job = this.queue.shift();
      this._run(job).catch((err) => {
        const t = this.store.tickets.get(job.ticketId);
        if (t) { t.status = 'error'; this.store.saveTicket(t.id); }
        this.store.appendActivity(job.ticketId, { kind: 'system', by: 'engine', text: `runner crash: ${err.message}` });
        this.running.delete(job.ticketId);
        this.broadcast({ type: 'state-changed' });
        this._pump();
      });
    }
  }

  async _run({ ticketId }) {
    const store = this.store;
    const ticket = store.tickets.get(ticketId);
    if (!ticket) return;
    const column = store.column(ticket.columnId);
    const harness = store.effectiveHarness(ticket, column);
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
    const transcriptFile = path.join(store.transcriptsDir(ticketId), `${stamp}-${column.name.toLowerCase()}.jsonl`);
    const transcript = fs.createWriteStream(transcriptFile);
    transcript.write(JSON.stringify({ meta: { cmd: inv.cmd, args: inv.args.map((a) => (a.length > 500 ? a.slice(0, 500) + '…' : a)), harness, column: column.name } }) + '\n');

    ticket.status = 'running';
    ticket.currentRun = { column: column.name, harness: harness.type, model: harness.model, startedAt: new Date().toISOString(), transcriptFile };
    store.saveTicket(ticketId);
    store.appendActivity(ticketId, { kind: 'run', by: harness.type, text: `run started: ${column.name} (${harness.model || 'default model'}, effort ${harness.effort || 'default'})` });
    this.broadcast({ type: 'state-changed' });

    const proc = spawn(inv.cmd, inv.args, { cwd: ticket.workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeoutMs = (store.board.settings.runTimeoutMin || 30) * 60 * 1000;
    const entry = { proc, columnId: column.id, stopped: false };
    entry.timer = setTimeout(() => { entry.timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    this.running.set(ticketId, entry);

    const state = { sessionId: null, finalText: '', exitInfo: null };
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let events = adapter.parseLine(line, state);
      if (!events) { transcript.write(JSON.stringify({ raw: line.slice(0, 2000) }) + '\n'); return; }
      if (!Array.isArray(events)) events = [events];
      for (const ev of events) {
        transcript.write(JSON.stringify({ ev }) + '\n');
        this.broadcast({ type: 'run-event', ticketId, column: column.name, event: ev });
      }
    });
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      transcript.write(JSON.stringify({ stderr: s }) + '\n');
    });

    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    clearTimeout(entry.timer);
    this.running.delete(ticketId);
    transcript.end();

    ticket.lastRunEndedAt = new Date().toISOString();
    delete ticket.currentRun;
    if (state.sessionId) ticket.sessions[harness.type] = state.sessionId;

    // Prefer the -o last-message file for codex; stream state for claude.
    let finalText = state.finalText;
    if (inv.lastMsgFile) {
      try { finalText = fs.readFileSync(inv.lastMsgFile, 'utf8') || finalText; } catch {}
    }

    if (entry.stopped) {
      ticket.status = 'idle';
      store.appendActivity(ticketId, { kind: 'system', by: 'human', text: 'run stopped' });
    } else if (entry.timedOut) {
      ticket.status = 'error';
      store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run timed out after ${store.board.settings.runTimeoutMin || 30} min` });
    } else if (exitCode !== 0) {
      ticket.status = 'error';
      store.appendActivity(ticketId, { kind: 'system', by: 'engine', text: `run failed (exit ${exitCode}): ${stderrTail.slice(-800) || 'no stderr'}` });
    } else {
      this._applyControl(ticket, column, harness, parseControlBlock(finalText), finalText);
    }

    store.saveTicket(ticketId);
    this.broadcast({ type: 'state-changed' });
    this._pump();
  }

  _applyControl(ticket, column, harness, control, finalText) {
    const store = this.store;
    if (!control) {
      ticket.status = 'awaiting-human';
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
        if (!target) { ticket.status = 'awaiting-human'; break; }
        ticket.status = 'idle';
        this.moveTicket(ticket.id, target.id, { by: harness.type });
        break;
      }
      case 'bounce': {
        const target = store.columnByName(control.target_column);
        ticket.bounces = (ticket.bounces || 0) + 1;
        if (!target || ticket.bounces > MAX_BOUNCES) {
          ticket.status = 'awaiting-human';
          store.appendActivity(ticket.id, { kind: 'system', by: 'engine', text: !target ? `bounce target "${control.target_column}" not found` : `bounce limit (${MAX_BOUNCES}) hit — needs a human decision` });
          break;
        }
        ticket.status = 'idle';
        this.moveTicket(ticket.id, target.id, { by: harness.type });
        break;
      }
      case 'flag_human':
        ticket.status = 'awaiting-human';
        break;
      case 'hold':
      default:
        ticket.status = 'idle';
        break;
    }
  }
}
