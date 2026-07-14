import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

test('moveTicket clears pending wake on column change', () => {
  const ticket = {
    id: 'ticket-a',
    columnId: 'col-build',
    status: 'idle',
    activity: [],
    readOnly: false,
    pendingWake: {
      at: Date.now() + 60000,
      by: 'human',
      harness: { type: 'codex', model: 'gpt-5', effort: 'high' },
    },
  };
  const columns = new Map([
    ['col-build', { id: 'col-build', name: 'Build', role: 'agent', autoRun: false }],
    ['col-review', { id: 'col-review', name: 'Review', role: 'agent', autoRun: false }],
  ]);
  const saved = [];
  const activity = [];
  const store = {
    tickets: new Map([['ticket-a', ticket]]),
    column: (id) => columns.get(id),
    appendActivity: (ticketId, entry) => activity.push({ ticketId, entry }),
    saveTicket: (ticketId) => saved.push(ticketId),
    reconcileClock: () => {},
  };

  const runner = new Runner(store, () => {});
  const moved = runner.moveTicket('ticket-a', 'col-review', { by: 'engine' });

  assert.equal(moved, ticket);
  assert.equal(ticket.columnId, 'col-review');
  assert.equal(ticket.pendingWake, undefined);
  assert.deepEqual(saved, ['ticket-a']);
  assert.equal(activity.length, 1);
});
