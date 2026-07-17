import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BranchPrepError,
  branchSlug,
  prepareTicketBranch,
  removeTicketWorktree,
  ticketBranchName,
  ticketWorktreePath,
} from '../engine/branching.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-branching-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dispatch@example.invalid']);
  git(dir, ['config', 'user.name', 'Dispatch Tests']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'Initial commit']);
  return dir;
}

function tempWorktreesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-worktrees-'));
}

function rmrf(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('ticketBranchName is deterministic, git-safe, and avoids reserved wording', () => {
  assert.equal(branchSlug('Codex: Build the Thing!'), 'agent-build-the-thing');
  assert.equal(
    ticketBranchName({ id: 't-abc123', seq: 7, title: 'Branch from Every Ticket' }),
    'DSP-7/branch-from-every-ticket',
  );
});

test('prepareTicketBranch creates an isolated worktree and leaves the main checkout alone', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    const base = git(repo, ['rev-parse', 'refs/heads/main']);
    const result = prepareTicketBranch({
      workspace: repo,
      worktreesRoot,
      ticket: { id: 't-abc123', seq: 7, title: 'Branch from Every Ticket' },
    });

    assert.equal(result.branchName, 'DSP-7/branch-from-every-ticket');
    assert.equal(result.branchBase, base);
    assert.equal(result.action, 'worktree-created');
    assert.equal(result.workDir, path.join(worktreesRoot, 't-abc123'));
    assert.equal(result.gitDir, path.join(repo, '.git'));
    assert.equal(git(result.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']), result.branchName);
    // The shared checkout was never switched.
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  } finally {
    rmrf(repo, worktreesRoot);
  }
});

test('a dirty main checkout never blocks a ticket run', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed\n');

    const result = prepareTicketBranch({
      workspace: repo,
      worktreesRoot,
      ticket: { id: 't-dirty', seq: 8, title: 'Dirty branch' },
    });

    assert.equal(result.action, 'worktree-created');
    assert.equal(git(result.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']), result.branchName);
    // Main checkout still on main, still dirty, untouched.
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'not committed\n');
    // The dirty file did not leak into the worktree.
    assert.equal(fs.existsSync(path.join(result.workDir, 'dirty.txt')), false);
  } finally {
    rmrf(repo, worktreesRoot);
  }
});

test('multiple tickets on one repo get independent worktrees', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    const a = prepareTicketBranch({ workspace: repo, worktreesRoot, ticket: { id: 't-a', seq: 1, title: 'First ticket' } });
    const b = prepareTicketBranch({ workspace: repo, worktreesRoot, ticket: { id: 't-b', seq: 2, title: 'Second ticket' } });

    assert.notEqual(a.workDir, b.workDir);
    assert.equal(git(a.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'DSP-1/first-ticket');
    assert.equal(git(b.workDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'DSP-2/second-ticket');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  } finally {
    rmrf(repo, worktreesRoot);
  }
});

test('prepareTicketBranch reuses the ticket worktree across runs, dirty or not', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    const ticket = { id: 't-continue', seq: 9, title: 'Continue work' };
    const first = prepareTicketBranch({ workspace: repo, worktreesRoot, ticket });
    fs.writeFileSync(path.join(first.workDir, 'wip.txt'), 'same ticket work\n');

    const second = prepareTicketBranch({
      workspace: repo,
      worktreesRoot,
      ticket: { ...ticket, branchName: first.branchName, branchBase: first.branchBase, branchedAt: first.branchedAt },
    });

    assert.equal(second.action, 'worktree-reused');
    assert.equal(second.workDir, first.workDir);
    assert.equal(second.branchName, first.branchName);
    assert.equal(fs.readFileSync(path.join(first.workDir, 'wip.txt'), 'utf8'), 'same ticket work\n');
  } finally {
    rmrf(repo, worktreesRoot);
  }
});

test('legacy tickets whose branch is checked out in the main workspace keep running there', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    const ticket = { id: 't-legacy', seq: 11, title: 'Legacy in-place ticket' };
    const branchName = ticketBranchName(ticket);
    git(repo, ['switch', '-c', branchName]);
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'legacy in-place work\n');

    const result = prepareTicketBranch({ workspace: repo, worktreesRoot, ticket: { ...ticket, branchName } });

    assert.equal(result.action, 'already-current');
    assert.equal(result.workDir, repo);
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), branchName);
    assert.equal(fs.existsSync(ticketWorktreePath(worktreesRoot, ticket)), false);
  } finally {
    rmrf(repo, worktreesRoot);
  }
});

test('prepareTicketBranch rejects a workspace that is not a git work tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-not-git-'));
  try {
    assert.throws(
      () => prepareTicketBranch({
        workspace: dir,
        worktreesRoot: dir,
        ticket: { id: 't-nogit', seq: 10, title: 'No repo here' },
      }),
      (err) => err instanceof BranchPrepError
        && err.kind === 'workspace-not-git'
        && err.detail.includes(dir),
    );
  } finally {
    rmrf(dir);
  }
});

test('prepareTicketBranch surfaces a branch held by a foreign checkout', () => {
  const repo = tempRepo();
  const rootA = tempWorktreesRoot();
  const rootB = tempWorktreesRoot();
  try {
    const ticket = { id: 't-held', seq: 12, title: 'Held elsewhere' };
    const first = prepareTicketBranch({ workspace: repo, worktreesRoot: rootA, ticket });

    assert.throws(
      () => prepareTicketBranch({
        workspace: repo,
        worktreesRoot: rootB,
        ticket: { ...ticket, branchName: first.branchName },
      }),
      (err) => err instanceof BranchPrepError
        && err.kind === 'branch-unavailable'
        && err.detail.includes(first.workDir),
    );
  } finally {
    rmrf(repo, rootA, rootB);
  }
});

test('worktree creation initializes submodules at their recorded commits', () => {
  const sub = tempRepo();
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  // Git only honors file-transport opt-ins from trusted sources (env/global config), not
  // repo config, so the submodule clone inside prepareTicketBranch needs the env var.
  // Real setups (qic/frontend) use https/ssh URLs and need none of this.
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    execFileSync('git', ['submodule', 'add', sub, 'frontend'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(repo, ['commit', '-m', 'Add frontend submodule']);

    // Record a submodule commit that exists ONLY in the local checkout (never pushed to
    // the submodule's origin) — the qic/frontend situation. The worktree must still be
    // able to check it out, via the superproject-alternate object store.
    const subCheckout = path.join(repo, 'frontend');
    git(subCheckout, ['config', 'user.email', 'dispatch@example.invalid']);
    git(subCheckout, ['config', 'user.name', 'Dispatch Tests']);
    fs.writeFileSync(path.join(subCheckout, 'wip.txt'), 'unpushed submodule work\n');
    git(subCheckout, ['add', 'wip.txt']);
    git(subCheckout, ['commit', '-m', 'Unpushed submodule WIP']);
    const unpushedSha = git(subCheckout, ['rev-parse', 'HEAD']);
    git(repo, ['add', 'frontend']);
    git(repo, ['commit', '-m', 'Point frontend at unpushed WIP']);

    const result = prepareTicketBranch({
      workspace: repo,
      worktreesRoot,
      ticket: { id: 't-submod', seq: 14, title: 'Submodule ticket' },
    });

    assert.equal(result.action, 'worktree-created');
    assert.equal(result.submodules?.ok, true, result.submodules?.detail);
    // The submodule is a real checkout in the worktree, not an empty folder, and it sits
    // on the recorded (remote-unknown) commit.
    assert.equal(fs.readFileSync(path.join(result.workDir, 'frontend', 'README.md'), 'utf8'), '# test\n');
    assert.equal(fs.readFileSync(path.join(result.workDir, 'frontend', 'wip.txt'), 'utf8'), 'unpushed submodule work\n');
    assert.equal(git(path.join(result.workDir, 'frontend'), ['rev-parse', 'HEAD']), unpushedSha);
  } finally {
    delete process.env.GIT_ALLOW_PROTOCOL;
    rmrf(sub, repo, worktreesRoot);
  }
});

test('removeTicketWorktree deletes the worktree and its registration but keeps the branch', () => {
  const repo = tempRepo();
  const worktreesRoot = tempWorktreesRoot();
  try {
    const ticket = { id: 't-remove', seq: 13, title: 'Remove me', workspace: repo };
    const prep = prepareTicketBranch({ workspace: repo, worktreesRoot, ticket });
    fs.writeFileSync(path.join(prep.workDir, 'scrap.txt'), 'uncommitted scrap\n');

    assert.equal(removeTicketWorktree({ ticket, worktreesRoot }), true);
    assert.equal(fs.existsSync(prep.workDir), false);
    assert.ok(!git(repo, ['worktree', 'list']).includes(prep.workDir));
    // The branch itself survives for later inspection or shipping.
    assert.equal(git(repo, ['rev-parse', '--verify', `refs/heads/${prep.branchName}`]).length > 0, true);
  } finally {
    rmrf(repo, worktreesRoot);
  }
});
