# Dispatch — PRD

**A kanban operating system for multi-harness agent work.**
Claude Code is the brain, Codex is the executor, and the board is the contract between them.

- **Owner:** Marcello Haupt
- **Date:** 2026-07-07
- **Status:** v1.0 — approved for immediate build
- **Host:** Starbird (always-on Linux desktop), reachable from MSI via Tailscale

---

## 1. Problem

Marcello's workflow already splits roles across agent harnesses: Claude Code plans and reviews, Codex builds. Today that split is manual — he re-explains context to each tool, shuttles output between terminals, and tracks state in his head. There is no single place where a task enters, flows through phases owned by different harnesses, and exits with proof it's done.

**The core pain: context re-explanation.** Every hand-off between Claude and Codex costs a re-brief. That's the thing Dispatch must kill.

## 2. Product vision

A local web app — a kanban board — where each **column is a phase** and each **phase has a harness**. A ticket dropped in "To Do" gets planned by Claude Code, which then moves the ticket to "Build," where Codex picks it up with full context already loaded, builds it, and moves it on — until the ticket lands in "Done" with a comment explaining how to human-test it (or stating that no testing is needed). Marcello watches, intervenes when he wants, and never re-explains anything.

It's an OS in the sense that it owns the lifecycle: intake → routing → execution → verification → hand-back to the human.

## 3. Users

One user: Marcello. Both machines matter:

- **Starbird** runs the server (agents execute here — it's always on and has both CLIs authed).
- **MSI** accesses the board over Tailscale in a browser.

No auth beyond network trust (Tailscale) for v1. Bind to `0.0.0.0`, rely on tailnet isolation.

## 4. Core concepts & data model

### Board
One or more boards. A board has ordered **columns** and a **default workspace** (the repo/dir agents work in). v1 ships one default board; the model supports many.

### Column (= phase)
```
{
  id, name, order,
  role: "intake" | "agent" | "human-gate" | "terminal",
  harness: {                    // default for tickets in this column
    type: "claude" | "codex" | "human",
    model: string,              // e.g. "claude-fable-5" or "gpt-5.5"
    effort: string,             // claude: low|medium|high|xhigh|max ; codex: low|medium|high|xhigh
    permissions: string,        // claude: --permission-mode ; codex: --sandbox
  },
  phasePrompt: string,          // what this phase means, templated into the run prompt
  autoRun: boolean,             // start the harness when a ticket arrives
  exitCriteria: string          // what must be true for the agent to advance the ticket
}
```

Default board:

| Column | Role | Harness | Phase job |
|---|---|---|---|
| **Backlog** | intake | human | Ticket intake, no automation |
| **Planning** | agent | Claude Code (fable, high) | Produce implementation plan + acceptance criteria into shared context |
| **Build** | agent | Codex (gpt-5.5, xhigh) | Implement the plan, commit work, report what changed |
| **Review** | agent | Claude Code (fable, max) | Review the diff against plan, fix or bounce back |
| **Done** | terminal | — | Requires human-test comment before entry |

Any column's harness is editable in the UI. Columns can be added, removed, reordered, and reassigned freely — the flow above is just the seeded default.

### Ticket
```
{
  id, title, description, columnId, createdAt,
  workspace: string,            // absolute path to the repo/dir for this ticket
  overrides: {                  // per-ticket harness override, wins over column default
    [columnId]: { type?, model?, effort?, permissions? }
  },
  maxBounces: number | null,    // null inherits the board default; 0 pauses on first bounce
  sessions: {                   // native session continuity per harness
    claude: uuid | null,        // claude -p --session-id / --resume
    codex: uuid | null          // codex exec resume <uuid>
  },
  status: "idle" | "queued" | "running" | "error" | "awaiting-human",
  activity: [ ... ]             // comments, moves, run transcripts, hand-offs
  humanTest: string | null      // required for Done; "NONE: <reason>" allowed
}
```

**Per-ticket model/effort selection** is a first-class UI affordance: when creating or editing a ticket, Marcello can pin harness/model/effort per column for that ticket, overriding the column default. ("This ticket is trivial — build with codex low effort. This one's hairy — plan with fable max.")

### Model & effort registry
Populated dynamically at server start and refreshable from the UI:

- **Claude:** aliases from the installed CLI (`fable`, `opus`, `sonnet`, `haiku`) plus full model ids; efforts `low|medium|high|xhigh|max`. Free-text model field allowed (new models ship faster than registries).
- **Codex:** default from `~/.codex/config.toml` plus known model set; efforts `low|medium|high|xhigh` via `-c model_reasoning_effort=`. Free-text allowed.

## 5. The context-sharing protocol (the whole point)

Three layers, so no harness ever needs a re-brief:

### Layer 1 — Native session resume (same harness, same ticket)
Each ticket keeps one persistent session **per harness**:
- Claude: first run mints a UUID → `claude -p --session-id <uuid>`; later runs use `claude -p --resume <uuid>`.
- Codex: first run parses the session id from `--json` events; later runs use `codex exec resume <uuid> "<prompt>"`.

When Claude re-enters a ticket at Review, it remembers its own Planning session natively.

### Layer 2 — The Dossier (cross-harness shared memory)
Every ticket owns `<dataDir>/tickets/<id>/DOSSIER.md` — a running hand-off document. Structure:

```markdown
# Ticket: <title>
## Brief            <- original description, immutable
## Plan             <- written by the Planning phase
## Work Log         <- appended by every phase: what I did, decisions, gotchas
## Open Questions
## How to Test      <- filled before Done
```

Rules enforced by the run engine:
1. Every agent run receives the dossier path and is instructed to **read it first**.
2. Every run must **append a Work Log entry** before finishing (what was done, what the next phase needs to know). Read-only runs should try the dossier write first; if the sandbox denies it, they put the entry in the optional control-block `work_log` field and the engine appends it.
3. The run prompt includes the last N activity items (comments, moves) so human comments on the ticket reach the agent too.

Codex picking up Build reads Claude's plan from the dossier — zero re-explanation. Claude picking up Review reads Codex's work log the same way.

### Layer 3 — Structured hand-off (machine-readable)
Every agent run must end its final message with a fenced control block:

```json
{"action": "advance" | "hold" | "bounce" | "flag_human",
 "target_column": "<name, optional>",
 "comment": "<posted to ticket activity>",
 "human_test": "<required when advancing to Done>",
 "work_log": "<optional read-only fallback: entry body>",
 "plan": "<optional read-only fallback: full Plan section body>"}
```

The engine parses this to move the ticket, post the comment, write optional read-only dossier fields, and enforce the Done gate. Missing/unparseable block → ticket goes to `awaiting-human` with the raw output attached (fail safe, never fail silent).

## 6. Run engine

### Execution
All runs execute on Starbird as child processes in the ticket's workspace:

**Claude Code:**
```
claude -p "<composed prompt>" \
  --model <model> --effort <effort> \
  --session-id <uuid> | --resume <uuid> \
  --permission-mode <mode> \
  --add-dir <ticket data dir> \
  --output-format stream-json --verbose \
  [--chrome]
```

**Codex:**
```
codex exec [resume <uuid>] "<composed prompt>" \
  -m <model> -c model_reasoning_effort=<effort> \
  --sandbox <mode> -C <workspace> --add-dir <ticket data dir> \
  --skip-git-repo-check --json \
  -o <ticket data dir>/last-message.txt
```

Both subscriptions are already OAuth-authed on Starbird (Claude Max, ChatGPT) — no API keys, no per-token billing.

### Prompt composition (per run)
```
[Phase prompt from column] + [exit criteria]
+ [Ticket title/description]
+ [Dossier path + read-first instruction]
+ [Recent activity (human comments since last run)]
+ [Tooling notes: puppeteer available via npm; Chrome extension if enabled]
+ [Hand-off contract: append Work Log, end with control block]
```

### Lifecycle & queue
- Ticket enters an `autoRun` agent column → run is **queued**. Global concurrency cap: 2 (configurable) — protects rate limits on both subscriptions.
- JSONL events stream from the child process → parsed → pushed over WebSocket to the UI (live transcript in the ticket modal).
- Exit 0 + valid control block → apply action. Nonzero exit or timeout (default 30 min, configurable) → `error` status, transcript attached, no move.
- **Bounce:** an agent can send a ticket backward (Review → Build) with a comment; the receiving harness resumes its own session and reads the bounce comment. Bounce loop cap is configurable per ticket, inherits the board default when blank, and defaults to 3 before pausing for human intervention.
- Manual controls always win: run/re-run/stop buttons, drag to any column (drag into an autoRun column offers to start a run).

### Done gate
A ticket cannot enter a `terminal` column without `human_test` populated — either testing steps or an explicit `NONE: <reason>`. Engine-enforced, not prompt-hoped: missing field → ticket parks in `awaiting-human` one column before Done.

## 7. Tool access

- **Puppeteer:** workspaces get standard tool access; the composed prompt tells agents Puppeteer is available (`npm i puppeteer`) for browser automation/scraping/UI verification.
- **Chrome extension (Claude in Chrome):** per-column/per-ticket toggle adds `--chrome` to Claude runs for real-browser driving. Claude-only; Codex tickets needing a browser use Puppeteer.
- **Permissions:** per-column defaults — Planning/Review run `--permission-mode auto` (claude) / `--sandbox read-only` (codex, review only); Build runs `acceptEdits` / `workspace-write`. A per-ticket "dangerous" toggle unlocks `bypassPermissions` / `danger-full-access` for trusted workspaces, off by default, visually loud when on. Read-only tickets force Claude to manual mode with `Write`/`Edit` allowed only inside the ticket data dir, and force Codex to `read-only`; Codex can still hand off through the optional `work_log`/`plan` control fields that the engine writes into the dossier.

## 8. UI spec

### Design direction (shape brief)
- **Purpose:** mission control for agent labor — glanceable state, deep drill-in.
- **Audience:** one power user, desktop-first (MSI browser), long sessions, often dark room.
- **Tone — committed aesthetic:** **industrial terminal / mission-control brutalism.** Dark, dense, monospace-forward, mechanical motion. Rigid grid, harsh 1px borders, high-contrast status color used sparingly (running amber, done green, error red, human-needed cyan). No cards-with-rounded-shadows, no generic AI gradient anything.
- **Differentiation:** the live agent transcript streaming inside a ticket — the board feels *staffed*, like watching a factory floor.
- **Constraints:** no build step, vanilla JS + one CSS file, must render fast over Tailscale, keyboard-friendly.

### Surfaces
1. **Board:** columns with harness badges (`CLAUDE · fable · high`), ticket cards showing status LED, current phase runtime, last activity line. Drag & drop. Global status bar: queue depth, running count, both CLI auth states.
2. **Ticket modal:** tabs — **Overview** (description, per-column overrides, workspace picker), **Activity** (comments + moves + hand-offs; comment box feeds the next run), **Transcript** (live stream of current/last run), **Dossier** (rendered markdown). Actions: Run now, Stop, Re-run phase, Move.
3. **Column config:** harness/model/effort/permissions pickers (registry-fed dropdowns + free text), phase prompt editor, autoRun toggle, exit criteria.
4. **New ticket:** title, description, workspace path, optional per-column overrides.

## 9. Architecture

```
Node 24, ~/git/dispatch
├─ server.mjs          HTTP (express) + WebSocket (ws)
├─ engine/
│  ├─ runner.mjs       queue, spawn, JSONL parsing, timeouts
│  ├─ claude.mjs       claude -p adapter (sessions, stream-json)
│  ├─ codex.mjs        codex exec adapter (sessions, --json)
│  └─ contract.mjs     prompt composer + control-block parser
├─ store.mjs           JSON persistence, atomic writes, ~/dispatch-data/
├─ registry.mjs        model/effort registry + CLI auth probe
└─ public/             index.html, app.js, dispatch.css (no build step)
```

- **Persistence:** JSON files under `~/dispatch-data/` (board.json, tickets/<id>/ticket.json + DOSSIER.md + transcripts/). Human-readable and greppable > database, at this scale. Atomic write-rename.
- **Systemd user service** (`dispatch.service`) so it survives reboots; port **4400**.

## 9b. Shipped post-v1.0

- **v1.1 — Feedback & mobile:** registry-driven select pickers for model/effort/permissions (scoped per harness, custom escape hatch), toast feedback on every action with surfaced refusal reasons, RUN from a human column starts the pipeline, mobile-responsive layout (swipe-snap columns, full-screen panels).
- **v1.2 — Auto-dispatch:** scheduler ticks every 60s. Unscheduled tickets in intake columns are swept into the pipeline every N minutes (default 5, settings-configurable, toggleable). A ticket with a `scheduledAt` timestamp waits for that exact time instead (checked each tick, fired once, then cleared). Set at creation or on the ticket overview.

## 10. Out of scope (v1) / Roadmap

- Multi-user, auth, mobile layout
- More harnesses (Gemini CLI, opencode) — adapter interface is designed for it
- Ticket dependencies/subtasks, Trello/GitHub sync, cost & token accounting dashboards, Telegram notifications on `flag_human` (natural v1.1 — Starbird already has the bot), parallel phase fan-out
- Cross-machine execution (running agents on MSI)

## 11. Success criteria

1. A ticket created on the board travels Backlog → Planning (Claude) → Build (Codex) → Review (Claude) → Done **with zero human re-explanation between phases**.
2. Codex's Build run demonstrably uses Claude's plan (references it in the work log) without the plan being pasted by a human.
3. Every Done ticket carries human-test instructions or an explicit NONE.
4. Per-ticket model/effort overrides visibly change the spawned CLI invocation.
5. A ticket bounced from Review reaches Build with the bounce comment in context, and Codex resumes its prior session.

## 12. Risks

| Risk | Mitigation |
|---|---|
| CLI flags drift across versions | Adapters isolate flags; auth+flag probe at startup surfaces breakage in the status bar |
| Agent ignores hand-off contract | Engine-side parsing with `awaiting-human` fallback; never auto-advance on unparseable output |
| Runaway runs burn subscription quota | Concurrency cap, per-run timeout, stop button, bounce cap |
| Session files grow unbounded | Dossier is curated (append-only but structured); transcripts rotate per run |
| Two agents writing one workspace | One run per ticket enforced; per-ticket workspaces recommended; worktree isolation on roadmap |
