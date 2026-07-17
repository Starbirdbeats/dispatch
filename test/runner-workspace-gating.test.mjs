import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../engine/runner.mjs';

test('runner does not start two queued tickets in the same non-git workspace at once', () => {
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

test('runner starts multiple tickets in the same git workspace — worktrees isolate them', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-gating-repo-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    const tickets = new Map([
      ['a', { id: 'a', workspace: repo }],
      ['b', { id: 'b', workspace: repo }],
    ]);
    const store = {
      board: { settings: { maxConcurrent: 2 } },
      tickets,
      saveQueue: () => {},
    };
    const runner = new Runner(store, () => {});
    const started = [];
    runner.queue = [
      { ticketId: 'a', columnId: 'col-build' },
      { ticketId: 'b', columnId: 'col-build' },
    ];
    runner._run = (job) => {
      started.push(job.ticketId);
      runner.running.set(job.ticketId, {});
      return Promise.resolve();
    };

    runner._pump();

    assert.deepEqual(started, ['a', 'b']);
    assert.equal(runner.queue.length, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
