import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

test('runner does not start two queued tickets in the same workspace at once', () => {
  const tickets = new Map([
    ['a', { id: 'a', workspace: '/tmp/workspace-one' }],
    ['b', { id: 'b', workspace: '/tmp/workspace-one' }],
    ['c', { id: 'c', workspace: '/tmp/workspace-two' }],
  ]);
  const savedQueues = [];
  const store = {
    board: { settings: { maxConcurrent: 2 } },
    tickets,
    saveQueue: (queue) => savedQueues.push(queue.map((job) => job.ticketId)),
  };
  const runner = new Runner(store, () => {});
  const started = [];
  runner.queue = [
    { ticketId: 'a', columnId: 'col-build' },
    { ticketId: 'b', columnId: 'col-build' },
    { ticketId: 'c', columnId: 'col-build' },
  ];
  runner._run = (job) => {
    started.push(job.ticketId);
    runner.running.set(job.ticketId, {});
    return Promise.resolve();
  };

  runner._pump();

  assert.deepEqual(started, ['a', 'c']);
  assert.deepEqual(runner.queue.map((job) => job.ticketId), ['b']);
  assert.deepEqual(savedQueues.at(-1), ['b']);
});
