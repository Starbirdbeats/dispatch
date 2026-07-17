import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspaceStatus } from '../engine/workspace-resolution.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-workspace-status-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dispatch@example.invalid']);
  git(dir, ['config', 'user.name', 'Dispatch Tests']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'Initial commit']);
  return dir;
}

test('inspectWorkspaceStatus reports a nonexistent path without throwing', async () => {
  const status = await inspectWorkspaceStatus(path.join(os.tmpdir(), 'dispatch-no-such-dir-xyz'));
  assert.equal(status.exists, false);
  assert.equal(status.isDirectory, false);
  assert.equal(status.gitWorkTree, false);
  assert.equal(status.error, null);
});

test('inspectWorkspaceStatus reports a blank workspace as missing', async () => {
  const status = await inspectWorkspaceStatus('   ');
  assert.equal(status.exists, false);
  assert.equal(status.gitWorkTree, false);
});

test('inspectWorkspaceStatus flags a plain directory as not a git work tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plain-dir-'));
  try {
    const status = await inspectWorkspaceStatus(dir);
    assert.equal(status.exists, true);
    assert.equal(status.isDirectory, true);
    assert.equal(status.gitWorkTree, false);
    assert.equal(status.dirty, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectWorkspaceStatus reports a clean repo with its branch', async () => {
  const repo = tempRepo();
  try {
    const status = await inspectWorkspaceStatus(repo);
    assert.equal(status.gitWorkTree, true);
    assert.equal(status.branch, 'main');
    assert.equal(status.dirty, false);
    assert.equal(status.changeCount, 0);
    assert.equal(status.error, null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('inspectWorkspaceStatus counts tracked and untracked changes', async () => {
  const repo = tempRepo();
  try {
    fs.appendFileSync(path.join(repo, 'README.md'), 'tracked edit\n');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n');
    const status = await inspectWorkspaceStatus(repo);
    assert.equal(status.dirty, true);
    assert.equal(status.changeCount, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
