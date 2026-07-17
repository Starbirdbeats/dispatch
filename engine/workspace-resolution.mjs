import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VALID_ACTIONS = new Set(['commit', 'stash']);

function git(workspace, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: workspace, timeout, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const detail = String(stderr || stdout || err?.message || '').trim();
      if (err) {
        const e = new Error(detail || `git ${args[0] || ''} failed`);
        e.code = err.code;
        e.signal = err.signal;
        reject(e);
      } else {
        resolve(out);
      }
    });
  });
}

function parsePorcelain(status) {
  return String(status || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }));
}

function cleanMessage(message, fallback) {
  const msg = String(message || fallback || '').replace(/\s+/g, ' ').trim();
  return msg.slice(0, 180) || fallback;
}

async function gitContext(workspace) {
  const raw = String(workspace || '').trim();
  if (!raw) throw new Error('ticket has no workspace configured');
  const target = path.resolve(raw);
  await git(target, ['rev-parse', '--is-inside-work-tree']);
  const [root, branch] = await Promise.all([
    git(target, ['rev-parse', '--show-toplevel']).then((s) => s.trim()).catch(() => target),
    git(target, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => 'HEAD'),
  ]);
  return { workspace: target, root, branch };
}

export async function inspectWorkspaceStatus(workspace) {
  const input = String(workspace || '').trim();
  const status = {
    input,
    path: input ? path.resolve(input) : '',
    exists: false,
    isDirectory: false,
    gitWorkTree: false,
    branch: null,
    dirty: false,
    changeCount: 0,
    error: null,
  };
  if (!input) return status;

  try {
    const stat = await fs.promises.stat(status.path);
    status.exists = true;
    status.isDirectory = stat.isDirectory();
  } catch {
    return status;
  }
  if (!status.isDirectory) return status;

  try {
    await git(status.path, ['rev-parse', '--is-inside-work-tree']);
    status.gitWorkTree = true;
  } catch {
    return status;
  }

  try {
    status.branch = (await git(status.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
    const changes = parsePorcelain(await git(status.path, ['status', '--porcelain']));
    status.dirty = changes.length > 0;
    status.changeCount = changes.length;
  } catch (err) {
    status.error = cleanMessage(err?.message, 'could not read workspace git status');
  }
  return status;
}

export function defaultWorkspaceResolveMessage(ticket) {
  if (Number.isFinite(ticket?.seq)) {
    return `DSP-${ticket.seq}: Save workspace changes before branch switch`;
  }
  return 'Dispatch: Save workspace changes before branch switch';
}

export async function inspectWorkspaceResolution({ workspace, ticket }) {
  const ctx = await gitContext(workspace);
  const status = await git(ctx.workspace, ['status', '--porcelain']);
  const changes = parsePorcelain(status);
  const dirty = changes.length > 0;
  return {
    ...ctx,
    dirty,
    changeCount: changes.length,
    changes: changes.slice(0, 80),
    defaultMessage: defaultWorkspaceResolveMessage(ticket),
    options: dirty
      ? [
          {
            action: 'commit',
            label: 'COMMIT + RETRY',
            detail: 'Commit all current workspace changes on the current branch, then retry this phase.',
          },
          {
            action: 'stash',
            label: 'STASH + RETRY',
            detail: 'Stash tracked and untracked workspace changes, then retry this phase.',
          },
        ]
      : [
          {
            action: 'retry',
            label: 'RETRY THIS PHASE',
            detail: 'The workspace is already clean.',
          },
        ],
  };
}

export async function resolveWorkspace({ workspace, ticket, action, message }) {
  if (!VALID_ACTIONS.has(action)) throw new Error(`unsupported workspace resolution: ${action || 'none'}`);

  const before = await inspectWorkspaceResolution({ workspace, ticket });
  if (!before.dirty) {
    return { ok: true, action: 'noop', before, after: before };
  }

  const commitMessage = cleanMessage(message, before.defaultMessage);
  let output = '';
  if (action === 'commit') {
    await git(before.workspace, ['add', '-A'], { timeout: 30_000 });
    output = await git(before.workspace, ['commit', '-m', commitMessage], { timeout: 120_000 });
  } else if (action === 'stash') {
    output = await git(before.workspace, ['stash', 'push', '--include-untracked', '-m', commitMessage], { timeout: 120_000 });
  }

  const after = await inspectWorkspaceResolution({ workspace, ticket });
  return {
    ok: !after.dirty,
    action,
    message: commitMessage,
    output: output.split('\n').slice(0, 20).join('\n'),
    before,
    after,
  };
}
