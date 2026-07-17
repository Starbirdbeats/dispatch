import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkUpdateStatus, createGitRunner, formatGitUpdateError, parseAheadBehind } from '../engine/update-status.mjs';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || '').trim());
    });
  });
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

async function makeRemoteBackedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-status-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const work = path.join(dir, 'work');

  await git(dir, ['init', '--bare', origin]);
  await git(dir, ['clone', origin, seed]);
  await git(seed, ['checkout', '-b', 'main']);
  await git(seed, ['config', 'user.email', 'dispatch@example.test']);
  await git(seed, ['config', 'user.name', 'Dispatch Test']);
  writeFile(path.join(seed, 'README.md'), 'one\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'initial']);
  await git(seed, ['push', '-u', 'origin', 'main']);

  await git(dir, ['clone', origin, work]);
  await git(work, ['checkout', 'main']);
  await git(work, ['config', 'user.email', 'dispatch@example.test']);
  await git(work, ['config', 'user.name', 'Dispatch Test']);

  return { dir, seed, work };
}

async function commitAndPushSeed(seed, text) {
  writeFile(path.join(seed, 'README.md'), text);
  await git(seed, ['add', 'README.md']);
  await git(seed, ['commit', '-m', 'upstream update']);
  await git(seed, ['push', 'origin', 'main']);
}

test('parseAheadBehind normalizes git rev-list counts', () => {
  assert.deepEqual(parseAheadBehind('3\n', '0\n'), { behind: 3, ahead: 0 });
  assert.deepEqual(parseAheadBehind('', ''), { behind: 0, ahead: 0 });
  assert.deepEqual(parseAheadBehind('x', 'y'), { behind: 0, ahead: 0 });
});

test('formatGitUpdateError summarizes DNS failures', () => {
  const error = new Error(`Command failed: git fetch --quiet origin main
ssh: Could not resolve hostname github.com: Name or service not known
fatal: Could not read from remote repository.`);

  assert.equal(formatGitUpdateError(error), 'network unavailable - cannot reach the update remote right now');
});

test('checkUpdateStatus degrades silently outside a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-status-'));
  try {
    const status = await checkUpdateStatus({ git: createGitRunner(dir) });
    assert.equal(status.behind, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.branch, null);
    assert.equal(status.state, 'status-error');
    assert.ok(status.error);
    assert.ok(status.checkedAt);
    assert.equal(status.localRef, 'refs/heads/main');
    assert.equal(status.remoteRef, 'refs/remotes/origin/main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkUpdateStatus reports up to date when local main matches origin main', async () => {
  const { dir, work } = await makeRemoteBackedRepo();
  try {
    const status = await checkUpdateStatus({ git: createGitRunner(work) });
    assert.equal(status.behind, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.branch, 'main');
    assert.equal(status.state, 'up-to-date');
    assert.equal(status.error, null);
    assert.ok(status.checkedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkUpdateStatus reports updates when origin main is ahead of local main', async () => {
  const { dir, seed, work } = await makeRemoteBackedRepo();
  try {
    await commitAndPushSeed(seed, 'two\n');
    const status = await checkUpdateStatus({ git: createGitRunner(work) });
    assert.equal(status.behind, 1);
    assert.equal(status.ahead, 0);
    assert.equal(status.branch, 'main');
    assert.equal(status.state, 'update-available');
    assert.equal(status.error, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkUpdateStatus reports a status error when origin main is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-status-'));
  try {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'user.email', 'dispatch@example.test']);
    await git(dir, ['config', 'user.name', 'Dispatch Test']);
    writeFile(path.join(dir, 'README.md'), 'one\n');
    await git(dir, ['add', 'README.md']);
    await git(dir, ['commit', '-m', 'initial']);

    const status = await checkUpdateStatus({ git: createGitRunner(dir) });
    assert.equal(status.behind, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.branch, null);
    assert.equal(status.state, 'status-error');
    assert.ok(status.error);
    assert.doesNotMatch(status.error, /Command failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
