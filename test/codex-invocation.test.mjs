import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from '../engine/codex.mjs';

function valueAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx === -1 ? null : args[idx + 1];
}

test('read-only Codex invocation can write ticket data but not the workspace root', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/tmp/workspace',
    sessionId: null,
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'danger-full-access',
      readOnly: true,
    },
  });

  assert.equal(valueAfter(args, '--sandbox'), 'workspace-write');
  assert.equal(valueAfter(args, '-C'), '/tmp/dispatch-ticket');
  assert.equal(args.includes('--add-dir'), false, 'workspace must not be added as a writable root');
  assert.ok(args.includes('sandbox_permissions=["disk-full-read-access"]'));
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket"]'));
  assert.ok(!args.some((a) => a.includes('/tmp/workspace/.git')));
});

test('resumed read-only Codex invocation keeps the same restricted write root', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/tmp/workspace',
    sessionId: 'session-id',
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'workspace-write',
      readOnly: true,
    },
  });

  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'session-id']);
  assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.includes('-C'), false);
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes('sandbox_permissions=["disk-full-read-access"]'));
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket"]'));
  assert.ok(!args.some((a) => a.includes('/tmp/workspace/.git')));
});

test('read-only column sandbox still lets Codex write the ticket data dir', () => {
  const inv = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/tmp/workspace',
    sessionId: null,
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'read-only',
    },
  });
  const { args } = inv;

  // A literal --sandbox read-only would ignore writable_roots and deny the dossier
  // update — it must map onto the anchored workspace-write shape instead.
  assert.equal(valueAfter(args, '--sandbox'), 'workspace-write');
  assert.equal(valueAfter(args, '-C'), '/tmp/dispatch-ticket');
  assert.equal(args.includes('--add-dir'), false, 'workspace must not be added as a writable root');
  assert.ok(args.includes('sandbox_permissions=["disk-full-read-access"]'));
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket"]'));
  assert.ok(!args.some((a) => a.includes('/tmp/workspace/.git')));
  assert.equal(inv.cwd, '/tmp/dispatch-ticket');
});

test('resumed read-only column sandbox pins cwd to the data dir', () => {
  const inv = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/tmp/workspace',
    sessionId: 'session-id',
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'read-only',
    },
  });

  assert.ok(inv.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(inv.args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket"]'));
  // `exec resume` has no -C flag — without a cwd override the process cwd (the
  // workspace) would become writable under workspace-write.
  assert.equal(inv.cwd, '/tmp/dispatch-ticket');
});

test('normal Codex invocation keeps workspace-write behavior for build phases', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/tmp/workspace',
    sessionId: null,
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'workspace-write',
    },
  });

  assert.equal(valueAfter(args, '--sandbox'), 'workspace-write');
  assert.equal(valueAfter(args, '-C'), '/tmp/workspace');
  assert.equal(valueAfter(args, '--add-dir'), '/tmp/dispatch-ticket');
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket","/tmp/workspace/.git"]'));
  assert.ok(!args.includes('sandbox_permissions=["disk-full-read-access"]'));
});

test('worktree Codex invocation gets the repo’s shared git dir as the writable root', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    workspace: '/data/worktrees/t-abc',
    gitDir: '/repos/project/.git',
    sessionId: null,
    harness: {
      type: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissions: 'workspace-write',
    },
  });

  assert.equal(valueAfter(args, '-C'), '/data/worktrees/t-abc');
  // In a worktree, workspace/.git is a file — commits need the shared git dir writable.
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/tmp/dispatch-ticket","/repos/project/.git"]'));
  assert.ok(!args.some((a) => a.includes('/data/worktrees/t-abc/.git')));
});
