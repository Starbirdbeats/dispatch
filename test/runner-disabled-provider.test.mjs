import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

test('runner parks ticket in setup when harness provider is disabled', () => {
  const ticket = {
    id: 'ticket-a',
    columnId: 'col-build',
    status: 'idle',
    activity: [],
    readOnly: false,
    sessions: {},
    overrides: {},
  };

  const col = { id: 'col-build', name: 'Build', harness: { type: 'codex', model: 'gpt-5.5' } };
  const store = {
    board: { settings: {} },
    tickets: new Map([['ticket-a', ticket]]),
    column: () => col,
    effectiveHarness: () => ({ type: 'codex', model: 'gpt-5.5', effort: 'xhigh', permissions: 'workspace-write' }),
    providerEnabled: () => false,
    appendActivity: () => {},
    saveTicket: () => {},
  };

  const runner = new Runner(store, () => {});
  const accepted = runner.enqueue('ticket-a');

  assert.equal(accepted, false);
  assert.equal(ticket.status, 'awaiting-human');
  assert.equal(ticket.stuckReason?.kind, 'provider-disabled');
  assert.match(ticket.stuckReason?.detail, /Codex is disabled/i);
  assert.equal(ticket.scheduledAt, null);
});

