import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BranchPrepError, branchSlug, prepareTicketBranch, ticketBranchName } from '../engine/branching.mjs';

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

test('ticketBranchName is deterministic, git-safe, and avoids reserved wording', () => {
  assert.equal(branchSlug('Codex: Build the Thing!'), 'agent-build-the-thing');
  assert.equal(
    ticketBranchName({ id: 't-abc123', seq: 7, title: 'Branch from Every Ticket' }),
    'DSP-7/branch-from-every-ticket',
  );
});

test('prepareTicketBranch creates and checks out a new ticket branch from main', () => {
  const repo = tempRepo();
  try {
    const base = git(repo, ['rev-parse', 'refs/heads/main']);
    const result = prepareTicketBranch({
      workspace: repo,
      ticket: { id: 't-abc123', seq: 7, title: 'Branch from Every Ticket' },
    });

    assert.equal(result.branchName, 'DSP-7/branch-from-every-ticket');
    assert.equal(result.branchBase, base);
    assert.equal(result.action, 'created');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), result.branchName);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('prepareTicketBranch blocks branch switching when the workspace is dirty', () => {
  const repo = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed\n');

    assert.throws(
      () => prepareTicketBranch({
        workspace: repo,
        ticket: { id: 't-dirty', seq: 8, title: 'Dirty branch' },
      }),
      (err) => err instanceof BranchPrepError
        && err.kind === 'branch-dirty'
        && /1 uncommitted change;/.test(err.detail),
    );
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('prepareTicketBranch rejects a workspace that is not a git work tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-not-git-'));
  try {
    assert.throws(
      () => prepareTicketBranch({
        workspace: dir,
        ticket: { id: 't-nogit', seq: 10, title: 'No repo here' },
      }),
      (err) => err instanceof BranchPrepError
        && err.kind === 'workspace-not-git'
        && err.detail.includes(dir),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareTicketBranch allows dirty continuation when already on the ticket branch', () => {
  const repo = tempRepo();
  try {
    const ticket = { id: 't-continue', seq: 9, title: 'Continue work' };
    const first = prepareTicketBranch({ workspace: repo, ticket });
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'same ticket work\n');
    const second = prepareTicketBranch({
      workspace: repo,
      ticket: { ...ticket, branchName: first.branchName, branchBase: first.branchBase, branchedAt: first.branchedAt },
    });

    assert.equal(second.branchName, first.branchName);
    assert.equal(second.action, 'already-current');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), first.branchName);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
