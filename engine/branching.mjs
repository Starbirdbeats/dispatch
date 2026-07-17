import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

export function isGitWorkTree(dir) {
  return canGit(dir, ['rev-parse', '--is-inside-work-tree']);
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

// The repo's shared .git directory — identical for the main checkout and every worktree
// of it, so it doubles as "same repo?" identity and as the writable root Codex needs
// for commits from inside a worktree (where .git is a file pointing here).
function gitCommonDir(dir) {
  try {
    return path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch {
    // --path-format needs git >= 2.31; older gits return a possibly-relative path.
    return path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
  }
}

// branch name -> checkout path, across the main checkout and all registered worktrees.
function branchCheckouts(repo) {
  const map = new Map();
  let current = null;
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && current) map.set(line.slice('branch refs/heads/'.length), current);
  }
  return map;
}

export function ticketWorktreePath(worktreesRoot, ticket) {
  return path.join(worktreesRoot, String(ticket?.id || 'ticket'));
}

// A fresh worktree checks out the superproject only — submodule folders start empty.
// Shared .git/modules storage makes this cheap when the main checkout already has the
// submodules; the first-ever init may clone over the network, hence the long timeout.
// Best effort by design: a submodule failure shouldn't park a ticket whose work may not
// touch the submodule at all — the runner surfaces the warning instead.
function submoduleEntries(workDir) {
  const out = git(workDir, ['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp); // submodule.<name>.path
    return { name: key.slice('submodule.'.length, -'.path'.length), path: line.slice(sp + 1) };
  });
}

function initSubmodules(workDir, commonDir) {
  if (!fs.existsSync(path.join(workDir, '.gitmodules'))) return { ok: true, skipped: true };
  try {
    git(workDir, ['submodule', 'update', '--init', '--recursive'], { timeout: 300_000 });
    return { ok: true };
  } catch {
    // Typical failure: the recorded submodule commit only exists in the main checkout
    // (unpushed WIP), so the fresh clone can't fetch it from origin. Seed each cloned
    // submodule with the branches of the main checkout's local module store, then retry —
    // the objects become available without touching the network.
    try {
      for (const { name, path: subPath } of submoduleEntries(workDir)) {
        const moduleStore = path.join(commonDir, 'modules', name);
        const subCheckout = path.join(workDir, subPath);
        if (!fs.existsSync(moduleStore) || !fs.existsSync(path.join(subCheckout, '.git'))) continue;
        try {
          git(subCheckout, ['fetch', '--no-tags', moduleStore, '+refs/heads/*:refs/dispatch/superproject/*'], { timeout: 120_000 });
        } catch { /* seed what we can; the retry below decides */ }
      }
      git(workDir, ['submodule', 'update', '--init', '--recursive'], { timeout: 300_000 });
      return { ok: true, seeded: true };
    } catch (err) {
      return { ok: false, detail: String(err?.stderr || err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 300) };
    }
  }
}

// Prepare an isolated checkout for a ticket run. The shared workspace checkout is never
// branch-switched and its dirty state never matters: each ticket gets a private git
// worktree under worktreesRoot, so any number of tickets can target one repo at once.
// Returns { branchName, branchBase, branchedAt, action, workDir, gitDir } where workDir
// is the directory the run must execute in.
export function prepareTicketBranch({ ticket, workspace, worktreesRoot }) {
  if (!canGit(workspace, ['rev-parse', '--is-inside-work-tree'])) {
    throw new BranchPrepError(
      'workspace-not-git',
      `Workspace is not a Git work tree: ${workspace}. Run git init (or point the ticket at a repo), or mark the ticket read-only.`,
    );
  }

  const branchName = ticket?.branchName || ticketBranchName(ticket);
  validateBranchName(workspace, branchName);
  const commonDir = gitCommonDir(workspace);
  const carried = {
    branchName,
    branchBase: ticket?.branchBase || null,
    branchedAt: ticket?.branchedAt || new Date().toISOString(),
    gitDir: commonDir,
  };

  // Legacy continuation: the shared checkout already sits on this ticket's branch
  // (pre-worktree runs). Keep running there so resumed sessions keep their cwd — its
  // dirty state is this ticket's own work in progress.
  if (currentBranch(workspace) === branchName) {
    return { ...carried, action: 'already-current', workDir: workspace };
  }

  if (!worktreesRoot) {
    throw new BranchPrepError('branch-unavailable', 'No worktree root configured — Dispatch cannot create the ticket worktree.');
  }
  const workDir = ticketWorktreePath(worktreesRoot, ticket);

  if (fs.existsSync(workDir)) {
    let sameRepo = false;
    try { sameRepo = gitCommonDir(workDir) === commonDir; } catch { /* not a work tree at all */ }
    if (!sameRepo) {
      throw new BranchPrepError(
        'worktree-conflict',
        `Ticket worktree folder exists but is not a worktree of ${workspace}: ${workDir}. Remove that folder, then retry this phase.`,
      );
    }
    const wtBranch = currentBranch(workDir);
    if (wtBranch === branchName) {
      return { ...carried, action: 'worktree-reused', workDir };
    }
    // The ticket's own worktree drifted to another branch (e.g. the branch was renamed).
    // Safe to re-point only if nothing uncommitted would be carried across.
    if (git(workDir, ['status', '--porcelain']).length > 0) {
      throw new BranchPrepError(
        'worktree-conflict',
        `Ticket worktree is on ${wtBranch || 'an unknown branch'} with uncommitted changes, but the ticket branch is ${branchName}: ${workDir}. Commit or clean the worktree, then retry this phase.`,
      );
    }
    let branchBase = carried.branchBase;
    if (branchExists(workDir, branchName)) {
      git(workDir, ['switch', branchName], { timeout: 60_000 });
    } else {
      const base = resolveBase(workspace);
      git(workDir, ['switch', '-c', branchName, base.ref], { timeout: 60_000 });
      branchBase = base.sha;
    }
    if (currentBranch(workDir) !== branchName) {
      throw new BranchPrepError('branch-unavailable', `Git switched the ticket worktree but HEAD is ${currentBranch(workDir) || 'unknown'}, not ${branchName}.`);
    }
    return { ...carried, branchBase, action: 'worktree-switched', workDir, submodules: initSubmodules(workDir, commonDir) };
  }

  // Fresh worktree. Prune first so a manually-deleted worktree folder doesn't leave a
  // stale registration that blocks re-adding the same path or branch.
  try { git(workspace, ['worktree', 'prune']); } catch { /* best effort */ }
  fs.mkdirSync(worktreesRoot, { recursive: true });

  if (branchExists(workspace, branchName)) {
    const heldAt = branchCheckouts(workspace).get(branchName);
    if (heldAt) {
      throw new BranchPrepError(
        'branch-unavailable',
        `Branch ${branchName} is already checked out at ${heldAt}, so Dispatch cannot create the ticket worktree. Switch that checkout to another branch (or remove the worktree), then retry this phase.`,
      );
    }
    git(workspace, ['worktree', 'add', workDir, branchName], { timeout: 120_000 });
    if (currentBranch(workDir) !== branchName) {
      throw new BranchPrepError('branch-unavailable', `Git created the ticket worktree but HEAD is ${currentBranch(workDir) || 'unknown'}, not ${branchName}.`);
    }
    return { ...carried, action: 'worktree-created', workDir, submodules: initSubmodules(workDir, commonDir) };
  }

  const base = resolveBase(workspace);
  git(workspace, ['worktree', 'add', '-b', branchName, workDir, base.ref], { timeout: 120_000 });
  if (currentBranch(workDir) !== branchName) {
    throw new BranchPrepError('branch-unavailable', `Git created the ticket worktree but HEAD is ${currentBranch(workDir) || 'unknown'}, not ${branchName}.`);
  }
  return {
    branchName,
    branchBase: base.sha,
    branchedAt: new Date().toISOString(),
    gitDir: commonDir,
    action: 'worktree-created',
    workDir,
    submodules: initSubmodules(workDir, commonDir),
  };
}

// Best-effort removal of a ticket's private worktree (ticket deletion). Force is
// intentional: the ticket is gone, so its uncommitted worktree scraps go with it.
// The ticket branch itself is left alone.
export function removeTicketWorktree({ ticket, worktreesRoot }) {
  if (!ticket?.id || !worktreesRoot) return false;
  const workDir = ticketWorktreePath(worktreesRoot, ticket);
  if (!fs.existsSync(workDir)) return false;
  try {
    git(ticket.workspace, ['worktree', 'remove', '--force', workDir], { timeout: 60_000 });
    return true;
  } catch {
    // The repo may be gone or the folder may not be a registered worktree — take the
    // folder out directly and prune whatever registration is left behind.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { git(ticket.workspace, ['worktree', 'prune']); } catch { /* best effort */ }
    return !fs.existsSync(workDir);
  }
}
