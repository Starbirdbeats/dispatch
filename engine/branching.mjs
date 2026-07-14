import { execFileSync } from 'node:child_process';

export class BranchPrepError extends Error {
  constructor(kind, detail) {
    super(detail);
    this.name = 'BranchPrepError';
    this.kind = kind;
    this.detail = detail;
  }
}

function git(workspace, args, { timeout = 15_000 } = {}) {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  }).trim();
}

function canGit(workspace, args) {
  try {
    git(workspace, args);
    return true;
  } catch {
    return false;
  }
}

export function branchSlug(title) {
  let slug = String(title || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/codex/g, 'agent')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

export function ticketBranchName(ticket) {
  const prefix = Number.isFinite(ticket?.seq) ? `DSP-${ticket.seq}` : String(ticket?.id || 'ticket');
  return `${prefix}/${branchSlug(ticket?.title)}`;
}

function validateBranchName(workspace, branchName) {
  try {
    git(workspace, ['check-ref-format', '--branch', branchName]);
  } catch {
    throw new BranchPrepError('branch-unavailable', `Generated branch name is not valid for Git: ${branchName}`);
  }
}

function branchExists(workspace, branchName) {
  return canGit(workspace, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
}

function resolveBase(workspace) {
  for (const ref of ['refs/heads/main', 'refs/remotes/origin/main', 'HEAD']) {
    try {
      const sha = git(workspace, ['rev-parse', '--verify', ref]);
      if (sha) return { ref, sha };
    } catch {
      // Try the next candidate.
    }
  }
  throw new BranchPrepError('branch-unavailable', 'Could not resolve a branch base from main, origin/main, or HEAD.');
}

function currentBranch(workspace) {
  try {
    return git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

function dirty(workspace) {
  return Boolean(git(workspace, ['status', '--porcelain']));
}

export function prepareTicketBranch({ ticket, workspace }) {
  if (!canGit(workspace, ['rev-parse', '--is-inside-work-tree'])) {
    throw new BranchPrepError('branch-unavailable', 'Workspace is not a Git work tree; cannot start this ticket on a branch.');
  }

  const branchName = ticket?.branchName || ticketBranchName(ticket);
  validateBranchName(workspace, branchName);

  const current = currentBranch(workspace);
  if (current === branchName) {
    return {
      branchName,
      branchBase: ticket?.branchBase || null,
      branchedAt: ticket?.branchedAt || new Date().toISOString(),
      action: 'already-current',
    };
  }

  if (dirty(workspace)) {
    throw new BranchPrepError(
      'branch-dirty',
      `Workspace has uncommitted changes; clean or commit them before Dispatch switches to ${branchName}.`,
    );
  }

  if (branchExists(workspace, branchName)) {
    git(workspace, ['switch', branchName], { timeout: 30_000 });
    const after = currentBranch(workspace);
    if (after !== branchName) {
      throw new BranchPrepError('branch-unavailable', `Git switched branches but HEAD is ${after || 'unknown'}, not ${branchName}.`);
    }
    return {
      branchName,
      branchBase: ticket?.branchBase || null,
      branchedAt: ticket?.branchedAt || new Date().toISOString(),
      action: 'switched',
    };
  }

  const base = resolveBase(workspace);
  git(workspace, ['switch', '-c', branchName, base.ref], { timeout: 30_000 });
  const after = currentBranch(workspace);
  if (after !== branchName) {
    throw new BranchPrepError('branch-unavailable', `Git created the branch but HEAD is ${after || 'unknown'}, not ${branchName}.`);
  }
  return {
    branchName,
    branchBase: base.sha,
    branchedAt: new Date().toISOString(),
    action: 'created',
  };
}
