# Dispatch v2 frontend

An isolated, mobile-first workflow studio. The original frontend and runner are unchanged.

## Run

`node v2-server.mjs` serves the studio at `http://127.0.0.1:4420`.

To test from a phone on the same network, set `DISPATCH_V2_HOST` to the Mac's LAN IP before starting the server. `DISPATCH_V2_PORT` defaults to 4420.

## Scope

- Ticket board with backlog, in-progress, attention, and completed states.
- Add, rename, and reorder board columns. Custom columns organise drafts.
- Guided ticket creation using four editable workflow templates.
- Sequential stage editor with prompts, agent choices, gates, retry routes, and attempt limits.
- Per-stage model, model-specific reasoning effort, and supported fast-mode choices. Older drafts use provider defaults. Changing providers/models clears incompatible options; Human has no model controls. The catalogue is a configuration snapshot, not an authenticated availability check. Fast mode is off by default and remains simulated along with execution.
- Test execution: simulated passes, injected failures, bounded retries, pause/resume, human approvals, evidence, and event history.
- Local browser persistence, with active runs paused when the page reopens.
- Mobile vertical graph and stage inspector; desktop horizontal graph and inspector sidebar.

The test runner executes no models, shell commands, deployments, or repository writes. Gate evidence is explicitly simulated. Real agent execution, parallel branches, shared device persistence, and connection to the v1 runner are not part of this frontend preview. Each browser has its own board. The server only serves a fixed allowlist of frontend assets.

## Verification

`node --test test/v2-model.test.mjs`

The model tests cover approval gating, failure routing, downstream invalidation, attempt limits, pause/resume, template isolation, and graph validation.

Browser verification on 2026-09-06 passed at 320px, 390px, 768px, and 1440px viewport widths. The exercised flow created a two-stage ticket, edited a stage, injected a failure, retried, waited for human approval, and reached Completed. A reload retained the completion evidence. Column creation/reordering persisted after reload. Added stages and stage reordering worked; reopening an active run paused it. Narrow viewport checks found no page overflow, and the tablet editor's visible button/input/select controls met the 44px height target. These were browser viewport checks, not physical-phone tests.

## Design intent

Use the board to supervise outcomes and each ticket's graph to define execution. Gates show the required proof and failure route. Keep all core interactions available on phones without drag-and-drop or hover. The existing Dispatch paper palette is retained with cleaner surfaces and larger type.
# Guided tutorial and identity

The v2 favicon and header use the approved graph-and-loop D mark as a crisp SVG.
Open Guide and choose Start guided tutorial. Seven contextual steps follow the
real creation wizard, stage editor, simulated failure routing, and human gate.
Tutorial tickets advance manually, remain in the browser, and can be resumed
from Guide. Exit keeps the ticket; completed tutorials can be replayed with a new
practice ticket. This does not connect real providers or change the v1 frontend.
