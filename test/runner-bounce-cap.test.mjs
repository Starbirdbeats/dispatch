import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

function makeRunner({ boardMaxBounces = 3 } = {}) {
  const activity = [];
  const target = { id: 'col-build', name: 'Build' };
  const store = {
    board: { settings: { maxBounces: boardMaxBounces } },
    columnByName: (name) => (name === target.name ? target : null),
    appendActivity: (id, item) => activity.push({ id, item }),
    appendWorkLog: () => {},
    writePlan: () => {},
  };
  return { runner: new Runner(store, () => {}), activity, target };
}

function bounceControl() {
  return {
    action: 'bounce',
    target_column: 'Build',
    comment: 'Needs another pass.',
  };
}

test('per-ticket bounce cap wins over board default', () => {
  const ticket = { id: 't1', status: 'running', bounces: 2, maxBounces: 2 };
  const { runner, activity } = makeRunner({ boardMaxBounces: 3 });

  runner._applyControl(ticket, { id: 'col-review', name: 'Review' }, { type: 'claude' }, bounceControl(), '');

  assert.equal(ticket.bounces, 3);
  assert.equal(ticket.status, 'awaiting-human');
  assert.equal(ticket.stuckReason.kind, 'bounce-limit');
  assert.match(ticket.stuckReason.detail, /limit 2/);
  assert.match(activity.at(-1).item.text, /bounce limit \(2\)/);
});

test('board default bounce cap is used when ticket cap is unset', () => {
  const ticket = { id: 't2', status: 'running', bounces: 1 };
  const { runner, activity } = makeRunner({ boardMaxBounces: 1 });

  runner._applyControl(ticket, { id: 'col-review', name: 'Review' }, { type: 'claude' }, bounceControl(), '');

  assert.equal(ticket.bounces, 2);
  assert.equal(ticket.status, 'awaiting-human');
  assert.equal(ticket.stuckReason.kind, 'bounce-limit');
  assert.match(ticket.stuckReason.detail, /limit 1/);
  assert.match(activity.at(-1).item.text, /bounce limit \(1\)/);
});

test('under-cap bounce moves to the requested target column', () => {
  const ticket = { id: 't3', status: 'running', bounces: 0, maxBounces: 2 };
  const { runner, target } = makeRunner({ boardMaxBounces: 1 });
  let moved = null;
  runner.moveTicket = (id, col, opts) => { moved = { id, col, opts }; };

  runner._applyControl(ticket, { id: 'col-review', name: 'Review' }, { type: 'claude' }, bounceControl(), '');

  assert.equal(ticket.bounces, 1);
  assert.equal(ticket.status, 'idle');
  assert.deepEqual(moved, { id: 't3', col: target.id, opts: { by: 'claude' } });
});
