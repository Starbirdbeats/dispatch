import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

function makeRunner(tickets, { maxConcurrent = 1 } = {}) {
  const store = {
    board: { settings: { maxConcurrent } },
    tickets,
    saveQueue: () => {},
    appendActivity: () => {},
  };
  const runner = new Runner(store, () => {});
  const started = [];
  runner._run = (job) => {
    started.push(job.ticketId);
    runner.running.set(job.ticketId, {});
    return Promise.resolve();
  };
  return { runner, started };
}

test('forceStart starts a queued ticket past the concurrency cap', () => {
  const tickets = new Map([
    ['a', { id: 'a', workspace: '/tmp/workspace-one' }],
    ['b', { id: 'b', workspace: '/tmp/workspace-two' }],
  ]);
  const { runner, started } = makeRunner(tickets);
  runner.running.set('a', {});
  runner.queue = [{ ticketId: 'b', columnId: 'col-build' }];

  const r = runner.forceStart('b');

  assert.equal(r.started, true);
  assert.deepEqual(started, ['b']);
  assert.deepEqual(runner.queue, []);
});

test('forceStart refuses a ticket that is already running', () => {
  const tickets = new Map([['a', { id: 'a', workspace: '/tmp/workspace-one' }]]);
  const { runner, started } = makeRunner(tickets);
  runner.running.set('a', {});

  const r = runner.forceStart('a');

  assert.equal(r.started, false);
  assert.equal(r.reason, 'already running');
  assert.deepEqual(started, []);
});

test('forceStart keeps the per-workspace lock', () => {
  const tickets = new Map([
    ['a', { id: 'a', workspace: '/tmp/workspace-one' }],
    ['b', { id: 'b', workspace: '/tmp/workspace-one' }],
  ]);
  const { runner, started } = makeRunner(tickets);
  runner.running.set('a', {});
  runner.queue = [{ ticketId: 'b', columnId: 'col-build' }];

  const r = runner.forceStart('b');

  assert.equal(r.started, false);
  assert.equal(r.workspaceBusy, true);
  assert.match(r.reason, /workspace/);
  assert.deepEqual(started, []);
  assert.deepEqual(runner.queue.map((j) => j.ticketId), ['b']);
});

test('forceStart can override the workspace lock when told to', () => {
  const tickets = new Map([
    ['a', { id: 'a', workspace: '/tmp/workspace-one' }],
    ['b', { id: 'b', workspace: '/tmp/workspace-one' }],
  ]);
  const { runner, started } = makeRunner(tickets);
  runner.running.set('a', {});
  runner.queue = [{ ticketId: 'b', columnId: 'col-build' }];

  const r = runner.forceStart('b', { ignoreWorkspaceLock: true });

  assert.equal(r.started, true);
  assert.deepEqual(started, ['b']);
  assert.deepEqual(runner.queue, []);
});

test('forceStart reports a ticket that is not queued', () => {
  const tickets = new Map([['a', { id: 'a', workspace: '/tmp/workspace-one' }]]);
  const { runner } = makeRunner(tickets);

  const r = runner.forceStart('a');

  assert.equal(r.started, false);
  assert.equal(r.reason, 'not queued');
});
