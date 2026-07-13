# Dispatch — Zero-Orphan Runs (design sketch)

**Status:** proposal · 2026-07-08
**Problem owner:** the run engine (`engine/runner.mjs`) + `dispatch.service`

## 1. Problem

Agent runs are child processes of the Dispatch server. When the server dies — deploy restart,
crash, reboot — every in-flight `claude -p` / `codex exec` dies with it, and every queued job
evaporates (the queue lives in memory).

Shipped mitigations so far:
- boot cleanup flags killed tickets `interrupted` and re-queues them (commit `ccdad03`)
- harness sessions persist on disk, so re-runs resume context instead of starting cold

That's recovery, not prevention. The re-run still repeats work (wasted minutes + quota), and a
run killed mid-side-effect (half-written commit, half-applied migration) repeats that side effect.
Goal: **a Dispatch restart never kills, loses, or duplicates a run.**

## 2. Core idea

Decouple run lifetime from server lifetime. Runs become **detached processes journaling to disk**;
the server is just an *observer* that can attach, detach, and re-attach at any time.

```
ticket dir/
  runs/<runId>/
    cmd.json        invocation, harness, columnId, startedAt, deadlineAt, pid, pgid
    events.jsonl    child stdout (the JSONL stream we already parse)
    stderr.log
    exit.json       written by the wrapper when the child exits: {code, endedAt}
    finalized.json  written by the server after post-run handling (rename-once guard)
```

### 2.1 Spawn (wrapper, not direct child)

`bin/dispatch-run.sh <runId-dir> -- <cmd> <args…>`:
1. `setsid` itself (new process group, survives the server's death)
2. exec the harness CLI with stdout→`events.jsonl`, stderr→`stderr.log`
3. on child exit, atomically write `exit.json`

Server writes `cmd.json` (incl. `deadlineAt = now + runTimeoutMin`), spawns the wrapper with
`detached: true, stdio: 'ignore'`, records `{runId, pid, pgid}` in `ticket.json.activeRun`,
and `unref()`s it.

### 2.2 The systemd catch (critical)

`systemd --user` kills the **whole cgroup** on restart by default — detaching alone is not enough.
Two options:
- `KillMode=mixed` in `dispatch.service`: SIGTERM goes only to the main process on stop; runs
  survive restarts. Simplest, one line. (On `systemctl kill`/failure paths the cgroup can still
  be reaped — acceptable.)
- Bulletproof variant: launch each run as its own transient scope:
  `systemd-run --user --scope --unit=dispatch-run-<runId> bin/dispatch-run.sh …` — the run lives
  in its own cgroup, fully independent of `dispatch.service`. Slightly more moving parts.

Start with `KillMode=mixed`; graduate to scopes only if we observe reaping.

### 2.3 Attach loop (replaces in-process stdout piping)

For every `activeRun`:
- tail `events.jsonl` from a persisted byte offset (fs.watch + 1s poll fallback), feed lines
  through the existing adapter `parseLine()` → broadcast + transcript, exactly as today
- every few seconds: `kill(pid, 0)` liveness check, `exit.json` existence check,
  `now > deadlineAt` → `kill(-pgid, SIGKILL)` (timeout now survives restarts too)
- STOP button = `kill(-pgid, SIGTERM)`, escalate to SIGKILL after 5s — works after re-attach
  because pgid is on disk, not in memory

### 2.4 Finalize (idempotent)

On `exit.json`: read last message (codex `-o` file / claude `result` event from the journal),
parse control block, apply move/comment/optional dossier `work_log` and `plan` fields/Done-gate.
Then `rename(exit.json → finalized.json)`. The rename is the exactly-once guard: whichever
server instance wins the rename does the post-run handling; a second finalizer finds nothing.

### 2.5 Boot protocol

For each ticket with `activeRun`:
| state on disk | action |
|---|---|
| pid alive | re-attach; nothing was lost |
| pid dead + `exit.json` | finalize normally — the run **completed while the server was down** |
| pid dead + no `exit.json` | today's fallback: mark interrupted, re-enqueue with session resume |

Queued-but-not-spawned jobs: persist the queue to `<dataDir>/queue.json` on every change;
boot re-queues it. (Closes the "queued jobs evaporate" hole.)

## 3. What stays the same

Adapters, prompt contract, control-block parsing, Done gate, bounce logic, UI protocol. Read-only
runs may include optional `work_log` and `plan` fields in the control block when their sandbox
blocks direct dossier writes; the finalizer writes those fields exactly once with the rest of
post-run handling.
This is a runner+service refactor; nothing above the engine layer notices.

## 4. Steps

1. `KillMode=mixed` in dispatch.service (one line, ship immediately — 80% of the win)
2. wrapper script + detached spawn + `activeRun` in ticket.json
3. attach loop (journal tail + liveness + deadline)
4. idempotent finalize + boot protocol; delete the old in-process pipe path
5. queue persistence
6. chaos test: `systemctl --user restart dispatch` mid-Planning ×5 — expect zero lost runs,
   zero duplicate side effects, transcripts intact

Rough size: ~250 lines changed in `runner.mjs`, +60-line wrapper, 1-line service change.

## 5. Risks / edge cases

- **PID reuse** after reboot → validate with `startedAt` vs `/proc/<pid>/stat` start time, or
  just trust `exit.json` (wrapper outlives child, writes it even if server is gone)
- **fs.watch flakiness** on some filesystems → the 1s poll fallback is authoritative
- **Reboot mid-run** → pid dead, no exit.json → interrupted fallback (unavoidable; a reboot
  kills everything — session resume is the floor)
- **Double server instance** (manual `node server.mjs` + systemd) → `finalized.json` rename
  guard prevents double-apply; a port-bind check at boot prevents the scenario anyway
