import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
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
