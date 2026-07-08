// store.mjs — JSON persistence for boards and tickets. Atomic writes, human-greppable on disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DISPATCH_DATA || path.join(os.homedir(), 'dispatch-data');
const TICKETS_DIR = path.join(DATA_DIR, 'tickets');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');

const DEFAULT_BOARD = {
  settings: {
    maxConcurrent: 2,
    runTimeoutMin: 30,
    defaultWorkspace: path.join(os.homedir(), 'git'),
    autoDispatch: true,          // sweep intake columns and start pipelines automatically
    autoDispatchEveryMin: 5,
  },
  columns: [
    {
      id: 'col-backlog', name: 'Backlog', order: 0, role: 'intake',
      harness: { type: 'human' },
      phasePrompt: '', autoRun: false, exitCriteria: '',
    },
    {
      id: 'col-planning', name: 'Planning', order: 1, role: 'agent',
      harness: { type: 'claude', model: 'claude-fable-5', effort: 'high', permissions: 'acceptEdits', allowedTools: '', chrome: false },
      phasePrompt: 'You are the PLANNING phase. Study the ticket and the workspace, then produce a concrete implementation plan: files to touch, approach, edge cases, acceptance criteria. Write the plan into the "## Plan" section of the dossier. Do NOT implement anything.',
      autoRun: true,
      exitCriteria: 'The dossier contains an actionable plan with acceptance criteria that the Build phase can execute without asking questions.',
    },
    {
      id: 'col-build', name: 'Build', order: 2, role: 'agent',
      harness: { type: 'codex', model: 'gpt-5.5', effort: 'xhigh', permissions: 'workspace-write' },
      phasePrompt: 'You are the BUILD phase. Read the plan in the dossier and implement it fully in the workspace. Commit your work with clear messages. If the plan is wrong or blocked, bounce back to Planning with specifics instead of guessing.',
      autoRun: true,
      exitCriteria: 'The plan is implemented, the code runs, and the work log explains what changed and why.',
    },
    {
      id: 'col-review', name: 'Review', order: 3, role: 'agent',
      harness: { type: 'claude', model: 'claude-fable-5', effort: 'max', permissions: 'acceptEdits', allowedTools: 'Bash(git *) Read Glob Grep', chrome: false },
      phasePrompt: 'You are the REVIEW phase. Diff the work against the plan and acceptance criteria in the dossier. Check correctness, quality, and completeness. Small fixes: describe them precisely and bounce to Build. Sound work: advance to Done — you MUST provide human_test instructions (or "NONE: <reason>").',
      autoRun: true,
      exitCriteria: 'Work verified against acceptance criteria; human-test instructions written.',
    },
    {
      id: 'col-done', name: 'Done', order: 4, role: 'terminal',
      harness: { type: 'human' },
      phasePrompt: '', autoRun: false, exitCriteria: '',
    },
  ],
};

const DOSSIER_TEMPLATE = (ticket) => `# Ticket: ${ticket.title}

## Brief
${ticket.description}

## Plan
_(written by the Planning phase)_

## Work Log
_(every phase appends: what was done, decisions, gotchas, what the next phase needs to know)_

## Open Questions

## How to Test
`;

function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export class Store {
  constructor() {
    fs.mkdirSync(TICKETS_DIR, { recursive: true });
    this.board = readJSON(BOARD_FILE) || structuredClone(DEFAULT_BOARD);
    if (!readJSON(BOARD_FILE)) this.saveBoard();
    this.tickets = new Map();
    for (const id of fs.readdirSync(TICKETS_DIR)) {
      const t = readJSON(path.join(TICKETS_DIR, id, 'ticket.json'));
      if (!t) continue;
      // Orphaned runs from a previous server process: no child exists anymore.
      if (t.status === 'running' || t.status === 'queued') t.status = 'idle';
      delete t.currentRun;
      this.tickets.set(t.id, t);
    }
  }

  saveBoard() { atomicWrite(BOARD_FILE, JSON.stringify(this.board, null, 2)); }

  ticketDir(id) { return path.join(TICKETS_DIR, id); }
  dossierPath(id) { return path.join(this.ticketDir(id), 'DOSSIER.md'); }
  transcriptsDir(id) { return path.join(this.ticketDir(id), 'transcripts'); }

  column(id) { return this.board.columns.find((c) => c.id === id); }
  columnByName(name) {
    return this.board.columns.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase());
  }
  nextColumn(id) {
    const sorted = [...this.board.columns].sort((a, b) => a.order - b.order);
    const i = sorted.findIndex((c) => c.id === id);
    return i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : null;
  }
  nextAgentColumn(id) {
    const sorted = [...this.board.columns].sort((a, b) => a.order - b.order);
    const from = sorted.findIndex((c) => c.id === id);
    return sorted.find((c, i) => i > from && c.role === 'agent') || null;
  }

  createTicket({ title, description, workspace, columnId, overrides, scheduledAt }) {
    const id = `t-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const ticket = {
      id, title, description: description || '',
      workspace: workspace || this.board.settings.defaultWorkspace,
      columnId: columnId || this.board.columns.find((c) => c.role === 'intake')?.id || this.board.columns[0].id,
      createdAt: new Date().toISOString(),
      overrides: overrides || {},
      scheduledAt: scheduledAt || null,
      sessions: { claude: null, codex: null },
      status: 'idle',
      bounces: 0,
      humanTest: null,
      activity: [],
    };
    fs.mkdirSync(this.transcriptsDir(id), { recursive: true });
    fs.writeFileSync(this.dossierPath(id), DOSSIER_TEMPLATE(ticket));
    this.tickets.set(id, ticket);
    this.saveTicket(id);
    return ticket;
  }

  saveTicket(id) {
    const t = this.tickets.get(id);
    if (t) atomicWrite(path.join(this.ticketDir(id), 'ticket.json'), JSON.stringify(t, null, 2));
  }

  appendActivity(id, item) {
    const t = this.tickets.get(id);
    if (!t) return;
    t.activity.push({ ts: new Date().toISOString(), ...item });
    this.saveTicket(id);
  }

  deleteTicket(id) {
    this.tickets.delete(id);
    fs.rmSync(this.ticketDir(id), { recursive: true, force: true });
  }

  readDossier(id) {
    try { return fs.readFileSync(this.dossierPath(id), 'utf8'); } catch { return ''; }
  }

  // Effective harness for a ticket in a column: column default merged with per-ticket override.
  effectiveHarness(ticket, column) {
    return { ...column.harness, ...(ticket.overrides?.[column.id] || {}) };
  }
}
