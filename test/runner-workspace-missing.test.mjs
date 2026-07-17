import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composePrompt } from '../engine/contract.mjs';
import { Runner } from '../engine/runner.mjs';

test('runner parks a ticket whose workspace folder no longer exists', async () => {
  const ticket = {
    id: 'ticket-ws',
    columnId: 'col-build',
    status: 'idle',
    activity: [],
    readOnly: false,
    sessions: {},
    overrides: {},
    workspace: path.join(os.tmpdir(), 'dispatch-no-such-workspace-xyz'),
  };

  const col = { id: 'col-build', name: 'Build', harness: { type: 'claude', model: 'claude-sonnet-5' } };
  const activity = [];
  const store = {
    board: { settings: {} },
    tickets: new Map([['ticket-ws', ticket]]),
    column: () => col,
    effectiveHarness: () => ({ type: 'claude', model: 'claude-sonnet-5', effort: 'high', permissions: 'manual' }),
    providerEnabled: () => true,
    appendActivity: (id, entry) => activity.push(entry),
    saveTicket: () => {},
  };

  const runner = new Runner(store, () => {});
  await runner._run({ ticketId: 'ticket-ws' });

  assert.equal(ticket.status, 'awaiting-human');
  assert.equal(ticket.stuckReason?.kind, 'workspace-missing');
  assert.match(ticket.stuckReason?.detail, /does not exist/);
  assert.match(ticket.stuckReason?.detail, /dispatch-no-such-workspace-xyz/);
  assert.ok(activity.some((a) => /workspace check failed/.test(a.text)));
});

test('runner skips branch prep for an existing workspace that is not a git repo', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-not-a-repo-'));
  try {
    const ticket = {
      id: 'ticket-plain-folder',
      title: 'Plain folder task',
      columnId: 'col-build',
      status: 'idle',
      activity: [],
      readOnly: false,
      sessions: {},
      overrides: {},
      workspace,
    };
    const activity = [];
    const store = {
      saveTicket: () => {},
      appendActivity: (id, entry) => activity.push(entry),
    };

    const runner = new Runner(store, () => {});
    const result = runner._prepareBranch(ticket);

    assert.equal(result.action, 'skipped-not-git');
    assert.equal(ticket.branchName, undefined);
    assert.equal(ticket.branchless?.kind, 'workspace-not-git');
    assert.match(ticket.branchless?.detail, /run without branch or commit support/);
    assert.ok(activity.some((a) => /branch skipped/.test(a.text)));

    const prompt = composePrompt({
      ticket,
      column: { name: 'Build' },
      harness: { type: 'codex' },
      dossierPath: path.join(os.tmpdir(), 'DOSSIER.md'),
      recentActivity: [],
      resume: false,
    });
    assert.match(prompt, /BRANCHLESS WORKSPACE/);
    assert.match(prompt, /Do not run git branch\/commit commands/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
