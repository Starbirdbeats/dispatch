import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyUpdateWithStrategy, assessMainDivergence, checkUpdateStatus, createGitRunner, formatGitUpdateError, parseAheadBehind, parseStatusChanges } from '../engine/update-status.mjs';

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

test('parseStatusChanges splits porcelain output into code + path', () => {
  assert.deepEqual(parseStatusChanges(' M server.mjs\n?? notes.txt\nM  staged.txt\n'), [
    { code: ' M', path: 'server.mjs' },
    { code: '??', path: 'notes.txt' },
    { code: 'M ', path: 'staged.txt' },
  ]);
  assert.deepEqual(parseStatusChanges(''), []);
});

test('parseStatusChanges repairs a first line whose leading space was trimmed', () => {
  // createGitRunner trims stdout: " M .gitignore\n?? new.txt" arrives as "M .gitignore\n?? new.txt".
  assert.deepEqual(parseStatusChanges('M .gitignore\n?? new.txt'), [
    { code: ' M', path: '.gitignore' },
    { code: '??', path: 'new.txt' },
  ]);
});

test('applyUpdateWithStrategy rejects unknown strategies', async () => {
  await assert.rejects(
    applyUpdateWithStrategy({ git: () => Promise.resolve(''), strategy: 'merge' }),
    /unsupported update strategy: merge/,
  );
});

test('stash strategy restores non-conflicting local changes after the fast-forward', async () => {
  const { dir, seed, work } = await makeRemoteBackedRepo();
  try {
    // Upstream adds a new file; the local change touches a different file → clean restore.
    writeFile(path.join(seed, 'notes.txt'), 'upstream\n');
    await git(seed, ['add', 'notes.txt']);
    await git(seed, ['commit', '-m', 'add notes']);
    await git(seed, ['push', 'origin', 'main']);

    writeFile(path.join(work, 'README.md'), 'local edit\n');
    await git(work, ['fetch', 'origin', 'main']);

    const gitRun = createGitRunner(work);
    const { localChanges } = await applyUpdateWithStrategy({ git: gitRun, strategy: 'stash' });

    assert.equal(localChanges, 'restored');
    assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), 'local edit\n');
    assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'upstream\n');
    assert.equal(await git(work, ['rev-parse', 'main']), await git(work, ['rev-parse', 'origin/main']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stash strategy parks conflicting local changes on the stash list', async () => {
  const { dir, seed, work } = await makeRemoteBackedRepo();
  try {
    await commitAndPushSeed(seed, 'two\n'); // upstream rewrites README…
    writeFile(path.join(work, 'README.md'), 'local edit\n'); // …and so does the local change
    await git(work, ['fetch', 'origin', 'main']);

    const gitRun = createGitRunner(work);
    const { localChanges } = await applyUpdateWithStrategy({ git: gitRun, strategy: 'stash' });

    assert.equal(localChanges, 'stashed');
    // Tree ends clean at the updated commit; the local edit is retrievable from stash.
    assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), 'two\n');
    assert.equal(await git(work, ['status', '--porcelain']), '');
    assert.match(await git(work, ['stash', 'list']), /stash@\{0\}/);
    assert.equal(await git(work, ['rev-parse', 'main']), await git(work, ['rev-parse', 'origin/main']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discard strategy drops tracked modifications but keeps untracked files', async () => {
  const { dir, seed, work } = await makeRemoteBackedRepo();
  try {
    await commitAndPushSeed(seed, 'two\n');
    writeFile(path.join(work, 'README.md'), 'local edit\n');
    writeFile(path.join(work, 'scratch.txt'), 'untracked\n');
    await git(work, ['fetch', 'origin', 'main']);

    const gitRun = createGitRunner(work);
    const { localChanges } = await applyUpdateWithStrategy({ git: gitRun, strategy: 'discard' });

    assert.equal(localChanges, 'discarded');
    assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), 'two\n');
    assert.equal(fs.readFileSync(path.join(work, 'scratch.txt'), 'utf8'), 'untracked\n');
    assert.equal(await git(work, ['rev-parse', 'main']), await git(work, ['rev-parse', 'origin/main']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Local main commits a change; origin gets the same patch as a different commit
// (the ship flow pushes rebased tips) plus one extra upstream commit.
async function makeDivergedTwinRepo() {
  const repo = await makeRemoteBackedRepo();
  const { seed, work } = repo;

  writeFile(path.join(work, 'feature.txt'), 'same patch\n');
  await git(work, ['add', 'feature.txt']);
  await git(work, ['commit', '-m', 'DSP-99: Add feature']);

  writeFile(path.join(seed, 'feature.txt'), 'same patch\n');
  await git(seed, ['add', 'feature.txt']);
  await git(seed, ['commit', '-m', 'DSP-99: Add feature (rebased)']);
  writeFile(path.join(seed, 'extra.txt'), 'upstream extra\n');
  await git(seed, ['add', 'extra.txt']);
  await git(seed, ['commit', '-m', 'upstream extra']);
  await git(seed, ['push', 'origin', 'main']);

  await git(work, ['fetch', 'origin', 'main']);
  return repo;
}

test('assessMainDivergence: ff when strictly behind, reset for rebased twins, blocked for unique work', async () => {
  const behindOnly = await makeRemoteBackedRepo();
  try {
    await commitAndPushSeed(behindOnly.seed, 'two\n');
    await git(behindOnly.work, ['fetch', 'origin', 'main']);
    assert.deepEqual(await assessMainDivergence({ git: createGitRunner(behindOnly.work) }), { mode: 'ff', uniqueCount: 0 });
  } finally {
    fs.rmSync(behindOnly.dir, { recursive: true, force: true });
  }

  const twins = await makeDivergedTwinRepo();
  try {
    assert.deepEqual(await assessMainDivergence({ git: createGitRunner(twins.work) }), { mode: 'reset', uniqueCount: 0 });
  } finally {
    fs.rmSync(twins.dir, { recursive: true, force: true });
  }

  const unique = await makeRemoteBackedRepo();
  try {
    writeFile(path.join(unique.work, 'only-here.txt'), 'local only\n');
    await git(unique.work, ['add', 'only-here.txt']);
    await git(unique.work, ['commit', '-m', 'local-only work']);
    await commitAndPushSeed(unique.seed, 'two\n');
    await git(unique.work, ['fetch', 'origin', 'main']);
    assert.deepEqual(await assessMainDivergence({ git: createGitRunner(unique.work) }), { mode: 'blocked', uniqueCount: 1 });
  } finally {
    fs.rmSync(unique.dir, { recursive: true, force: true });
  }
});

test('reset mode adopts origin/main and still restores stashed local changes', async () => {
  const { dir, work } = await makeDivergedTwinRepo();
  try {
    writeFile(path.join(work, 'README.md'), 'local edit\n');

    const gitRun = createGitRunner(work);
    assert.deepEqual(await assessMainDivergence({ git: gitRun }), { mode: 'reset', uniqueCount: 0 });
    const { localChanges } = await applyUpdateWithStrategy({ git: gitRun, strategy: 'stash', mode: 'reset' });

    assert.equal(localChanges, 'restored');
    assert.equal(await git(work, ['rev-parse', 'main']), await git(work, ['rev-parse', 'origin/main']));
    assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), 'local edit\n');
    assert.equal(fs.readFileSync(path.join(work, 'extra.txt'), 'utf8'), 'upstream extra\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clean tree with no strategy just advances main', async () => {
  const { dir, seed, work } = await makeRemoteBackedRepo();
  try {
    await commitAndPushSeed(seed, 'two\n');
    await git(work, ['fetch', 'origin', 'main']);
    const { localChanges } = await applyUpdateWithStrategy({ git: createGitRunner(work) });
    assert.equal(localChanges, null);
    assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), 'two\n');
    assert.equal(await git(work, ['rev-parse', 'main']), await git(work, ['rev-parse', 'origin/main']));
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
