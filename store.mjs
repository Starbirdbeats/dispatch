// store.mjs — JSON persistence for boards and tickets. Atomic writes, human-greppable on disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DISPATCH_DATA || path.join(os.homedir(), 'dispatch-data');
const TICKETS_DIR = path.join(DATA_DIR, 'tickets');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const DEFAULT_BOARD = {
  settings: {
    maxConcurrent: 2,
    runTimeoutMin: 30,
    defaultWorkspace: path.join(os.homedir(), 'git'),
    autoDispatch: true,          // sweep intake columns and start pipelines automatically
    autoDispatchEveryMin: 5,
    stallAfterMin: 10,           // stall watchdog: resume orphaned tickets after this dwell; 0 = off
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

## Attachments
_(none)_

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

// Reduce an untrusted upload name to a safe basename: no directories, no control
// chars, no leading dots (blocks "..", hidden files, and path traversal).
function sanitizeName(name) {
  return path.basename(String(name || ''))
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200) || 'file';
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Replace a "## Heading" block (heading line through just before the next "## ")
// with newBlock. Returns null if the heading isn't present so the caller can insert.
function replaceSection(doc, heading, newBlock) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return [...lines.slice(0, start), ...newBlock.split('\n'), '', ...lines.slice(end)].join('\n');
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
      // Legacy leftovers without an activeRun predate detached journals; the
      // runner will resume them after boot. Active runs are recovered separately.
      if (!t.activeRun && (t.status === 'running' || t.status === 'queued')) {
        t.status = 'idle';
        t.interrupted = true;
      }
      if (!t.activeRun) delete t.currentRun;
      this.tickets.set(t.id, t);
    }
  }

  saveBoard() { atomicWrite(BOARD_FILE, JSON.stringify(this.board, null, 2)); }
  saveQueue(queue) { atomicWrite(QUEUE_FILE, JSON.stringify(queue, null, 2)); }
  loadQueue() {
    const q = readJSON(QUEUE_FILE, []);
    return Array.isArray(q) ? q.filter((j) => j?.ticketId && j?.columnId) : [];
  }

  ticketDir(id) { return path.join(TICKETS_DIR, id); }
  dossierPath(id) { return path.join(this.ticketDir(id), 'DOSSIER.md'); }
  transcriptsDir(id) { return path.join(this.ticketDir(id), 'transcripts'); }
  runDir(id, runId) {
    const dir = path.join(this.ticketDir(id), 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  column(id) { return this.board.columns.find((c) => c.id === id); }
  columnByName(name) {
    return this.board.columns.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase());
  }
  // Sorted columns, minus any this ticket is set to skip (read-only tickets skip Build, etc.)
  _pipeline(ticket) {
    const skip = new Set(ticket?.skip || []);
    return [...this.board.columns].sort((a, b) => a.order - b.order).filter((c) => !skip.has(c.id));
  }
  // Next column after `id`, honouring the ticket's skip list.
  nextColumn(id, ticket = null) {
    const sorted = this._pipeline(ticket);
    // find where `id` sits in the FULL order, then take the next non-skipped column
    const order = this.column(id)?.order ?? -1;
    return sorted.find((c) => c.order > order) || null;
  }
  nextAgentColumn(id, ticket = null) {
    const order = this.column(id)?.order ?? -1;
    return this._pipeline(ticket).find((c) => c.order > order && c.role === 'agent') || null;
  }

  createTicket({ title, description, workspace, columnId, overrides, scheduledAt, attachments, readOnly, skip }) {
    const id = `t-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const ticket = {
      id, title, description: description || '',
      workspace: workspace || this.board.settings.defaultWorkspace,
      columnId: columnId || this.board.columns.find((c) => c.role === 'intake')?.id || this.board.columns[0].id,
      createdAt: new Date().toISOString(),
      enteredColumnAt: new Date().toISOString(),
      overrides: overrides || {},
      scheduledAt: scheduledAt || null,
      readOnly: Boolean(readOnly),
      skip: Array.isArray(skip) ? skip.filter((cid) => this.column(cid)) : [],
      sessions: { claude: null, codex: null },
      status: 'idle',
      bounces: 0,
      humanTest: null,
      startedAt: null,       // set when work first begins (enters an agent phase / first run)
      completedAt: null,     // set when it lands in a terminal column
      durationMs: null,      // completedAt - startedAt, frozen at completion
      attachments: [],
      activity: [],
    };
    fs.mkdirSync(this.transcriptsDir(id), { recursive: true });
    fs.writeFileSync(this.dossierPath(id), DOSSIER_TEMPLATE(ticket));
    this.tickets.set(id, ticket);
    for (const f of attachments || []) {
      try { ticket.attachments.push(this._writeAttachmentFile(id, f)); }
      catch { /* skip an unreadable upload — the ticket still gets created */ }
    }
    this.syncDossierAttachments(id);
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

  /* ---- attachments ----
     Files live under the ticket dir (attachments/<attId>/<name>) so both harnesses can
     read them: dataDir = ticketDir is inside codex's --add-dir sandbox, and claude reads
     absolute paths freely — the same mechanism that lets them read DOSSIER.md. */
  attachmentsDir(id) { return path.join(this.ticketDir(id), 'attachments'); }
  attachmentPath(id, meta) { return path.join(this.attachmentsDir(id), meta.id, meta.storedName); }

  _writeAttachmentFile(id, { name, type, dataB64 }) {
    const attId = crypto.randomBytes(4).toString('hex');
    const storedName = sanitizeName(name);
    const buf = Buffer.from(String(dataB64 || ''), 'base64');
    const dir = path.join(this.attachmentsDir(id), attId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, storedName), buf);
    return {
      id: attId,
      name: path.basename(String(name || storedName)) || storedName,
      storedName,
      type: type || '',
      size: buf.length,
      addedAt: new Date().toISOString(),
    };
  }

  addAttachment(id, file) {
    const t = this.tickets.get(id);
    if (!t) return null;
    const meta = this._writeAttachmentFile(id, file);
    (t.attachments ||= []).push(meta);
    this.syncDossierAttachments(id);
    this.saveTicket(id);
    return meta;
  }

  removeAttachment(id, attId) {
    const t = this.tickets.get(id);
    const meta = t?.attachments?.find((a) => a.id === attId);
    if (!meta) return false;
    t.attachments = t.attachments.filter((a) => a.id !== attId);
    fs.rmSync(path.join(this.attachmentsDir(id), meta.id), { recursive: true, force: true });
    this.syncDossierAttachments(id);
    this.saveTicket(id);
    return true;
  }

  resolveAttachment(id, attId) {
    const meta = this.tickets.get(id)?.attachments?.find((a) => a.id === attId);
    return meta ? { meta, path: this.attachmentPath(id, meta) } : null;
  }

  // Keep the dossier's "## Attachments" section in lockstep with the metadata, so the
  // agents (who read the dossier by absolute path) always see the current files and where
  // to read them. Called on every create/add/remove.
  syncDossierAttachments(id) {
    const t = this.tickets.get(id);
    if (!t) return;
    const atts = t.attachments || [];
    const body = atts.length
      ? ['## Attachments',
         '_Files the human attached for reference — read any relevant to your phase (absolute paths below)._',
         ...atts.map((a) => `- \`${a.name}\`${a.size ? ` (${fmtBytes(a.size)})` : ''} — ${this.attachmentPath(id, a)}`)].join('\n')
      : ['## Attachments', '_(none)_'].join('\n');
    let doc = this.readDossier(id);
    const replaced = replaceSection(doc, '## Attachments', body);
    if (replaced != null) doc = replaced;
    else {
      const at = doc.indexOf('\n## Plan'); // legacy dossiers predate the section — slot it before Plan
      doc = at !== -1 ? `${doc.slice(0, at)}\n${body}\n${doc.slice(at + 1)}` : `${doc.trimEnd()}\n\n${body}\n`;
    }
    fs.writeFileSync(this.dossierPath(id), doc);
  }

  // Effective harness for a ticket in a column: column default merged with per-ticket override.
  effectiveHarness(ticket, column) {
    return { ...column.harness, ...(ticket.overrides?.[column.id] || {}) };
  }
}
