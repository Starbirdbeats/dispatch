import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspaceResolution, resolveWorkspace } from '../engine/workspace-resolution.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-workspace-resolution-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dispatch@example.invalid']);
  git(dir, ['config', 'user.name', 'Dispatch Tests']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'Initial commit']);
  return dir;
}

test('inspectWorkspaceResolution reports available options for a dirty workspace', async () => {
  const repo = tempRepo();
  try {
    fs.appendFileSync(path.join(repo, 'README.md'), 'tracked edit\n');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed\n');

    const result = await inspectWorkspaceResolution({
      workspace: repo,
      ticket: { seq: 24 },
    });

    assert.equal(result.dirty, true);
    assert.equal(result.changeCount, 2);
    assert.ok(result.changes.some((change) => change.path === 'README.md'));
    assert.ok(result.changes.some((change) => change.path === 'dirty.txt'));
    assert.deepEqual(result.options.map((o) => o.action), ['commit', 'stash']);
    assert.equal(result.defaultMessage, 'DSP-24: Save workspace changes before branch switch');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveWorkspace can commit dirty workspace changes', async () => {
  const repo = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'committed by helper\n');

    const result = await resolveWorkspace({
      workspace: repo,
      ticket: { seq: 24 },
      action: 'commit',
      message: 'DSP-24: Save current work',
    });

    assert.equal(result.ok, true);
    assert.equal(result.after.dirty, false);
    assert.equal(git(repo, ['status', '--porcelain']), '');
    assert.equal(git(repo, ['log', '-1', '--pretty=%s']), 'DSP-24: Save current work');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveWorkspace can stash tracked and untracked changes', async () => {
  const repo = tempRepo();
  try {
    fs.appendFileSync(path.join(repo, 'README.md'), 'tracked change\n');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked change\n');

    const result = await resolveWorkspace({
      workspace: repo,
      ticket: { seq: 25 },
      action: 'stash',
      message: 'DSP-25: Save current work',
    });

    assert.equal(result.ok, true);
    assert.equal(result.after.dirty, false);
    assert.equal(git(repo, ['status', '--porcelain']), '');
    assert.match(git(repo, ['stash', 'list']), /DSP-25: Save current work/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
