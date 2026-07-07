# Dispatch

Kanban OS for multi-harness agent work. Claude Code plans and reviews, Codex builds — each column is a phase, each phase has a harness, and tickets flow through with zero context re-explanation.

Full spec: [PRD.md](PRD.md).

## Run

Runs as a systemd user service on Starbird:

```bash
systemctl --user status dispatch    # health
systemctl --user restart dispatch   # after code changes
journalctl --user -u dispatch -f    # logs
```

UI: `http://starbird:4400` (Tailscale) or `http://localhost:4400`.

## How it works

- **Columns = phases.** Each has a harness (`claude` / `codex` / `human`), model, effort, permissions, a phase prompt, and an auto-run toggle. Configure via the `CFG >>` button on any column.
- **Tickets** carry per-column overrides (this ticket's Build uses `gpt-5.4-mini` at `low`, say), a workspace path, and one persistent session per harness.
- **Context sharing** is three layers: native session resume (`claude -p --resume`, `codex exec resume`), the per-ticket `DOSSIER.md` every agent must read first and append a work log to, and recent ticket comments injected into each run prompt.
- **Hand-off contract:** every run ends with a JSON control block (`advance` / `hold` / `bounce` / `flag_human` + comment + optional `human_test`). No valid block → ticket parks at `awaiting-human`, never silently advances.
- **Done gate:** nothing enters a terminal column without human-test instructions (or an explicit `NONE: <reason>`).

## Data

Everything lives in `~/dispatch-data/` as plain files: `board.json`, `tickets/<id>/ticket.json`, `DOSSIER.md`, `transcripts/*.jsonl`. Grep away.

## Layout

```
server.mjs          HTTP + WebSocket API
store.mjs           JSON persistence
registry.mjs        model/effort registry + CLI probe
engine/runner.mjs   queue, spawn, stream, contract enforcement
engine/claude.mjs   claude -p adapter
engine/codex.mjs    codex exec adapter
engine/contract.mjs prompt composer + control-block parser
public/             vanilla JS frontend (no build step)
```
