import { execFile } from 'node:child_process';

export function parseAheadBehind(behindOut, aheadOut) {
  const count = (value) => {
    const parsed = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return { behind: count(behindOut), ahead: count(aheadOut) };
}

export function createGitRunner(cwd) {
  return function git(args, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || '').trim());
      });
    });
  };
}

export function formatGitUpdateError(error) {
  const raw = String(error?.message || error || '').trim();
  const detail = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Command failed: git\b/i.test(line))
    .join('\n')
    || raw;
  if (/could not resolve (host|hostname)|name or service not known|temporary failure in name resolution/i.test(raw)) {
    return 'network unavailable - cannot reach the update remote right now';
  }
  if (/network is unreachable|failed to connect|connection timed out|operation timed out/i.test(raw)) {
    return 'network unavailable - cannot reach the update remote right now';
  }
  if (/could not read from remote repository|permission denied|repository not found/i.test(raw)) {
    return 'update remote unavailable - check repository access';
  }
  return detail || 'update check failed';
}

export function parseStatusChanges(status) {
  return String(status || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // createGitRunner trims stdout, which strips the leading space from the first
      // porcelain line when its X code is blank (" M path" → "M path"). Genuine lines
      // always have a space at index 2 (the XY/path separator), so its absence there
      // identifies a trimmed line to reconstruct.
      if (line[1] === ' ' && line[2] !== ' ') {
        return { code: ` ${line[0]}`, path: line.slice(2) };
      }
      return { code: line.slice(0, 2), path: line.slice(3) };
    });
}

// Local main can trail origin/main in two ways: strictly behind (fast-forward is
// safe) or diverged. Diverged is still safely resolvable when every local-only
// commit is patch-equivalent to one already upstream (git cherry marks those '-'):
// the normal Dispatch ship flow pushes rebased tips to origin/main, leaving stale
// twins on local main. Only commits whose changes exist nowhere upstream block.
export async function assessMainDivergence({ git }) {
  try {
    await git(['merge-base', '--is-ancestor', 'refs/heads/main', 'refs/remotes/origin/main']);
    return { mode: 'ff', uniqueCount: 0 };
  } catch { /* diverged — check whether the local-only commits are upstream twins */ }
  const cherry = await git(['cherry', 'refs/remotes/origin/main', 'refs/heads/main']).catch(() => '+ unknown');
  const unique = cherry.split('\n').filter((line) => line.startsWith('+'));
  return unique.length ? { mode: 'blocked', uniqueCount: unique.length } : { mode: 'reset', uniqueCount: 0 };
}

// Advance local main to origin/main when the checkout is dirty. The Dispatch
// checkout is shared (agents and humans both edit it), so the caller must pick a
// strategy on the user's behalf:
//   'stash'   — stash everything (incl. untracked), fast-forward, pop. If the pop
//               conflicts the tree is reset to the new commit and the changes stay
//               parked on the stash list — never conflict markers in a tree the
//               server is about to restart from.
//   'discard' — reset --hard first (tracked modifications only; untracked files
//               stay in place), then fast-forward.
// Mode 'ff' fast-forwards; mode 'reset' (patch-equivalent divergence, see
// assessMainDivergence) hard-resets main onto origin/main instead.
// Returns { localChanges: 'restored' | 'stashed' | 'discarded' | null } for the client toast.
// (Not merge --autostash: on a conflicting restore that leaves conflict markers in
// the working tree in addition to the stash entry — exactly what we must avoid.)
export async function applyUpdateWithStrategy({ git, strategy = null, mode = 'ff' }) {
  const remoteRef = 'refs/remotes/origin/main';
  const advance = () => (mode === 'reset'
    ? git(['reset', '--hard', remoteRef], 30_000)
    : git(['merge', '--ff-only', remoteRef], 60_000));
  if (!strategy) { // clean tree — nothing to protect
    await advance();
    return { localChanges: null };
  }
  if (strategy === 'discard') {
    await git(['reset', '--hard'], 30_000);
    await advance();
    return { localChanges: 'discarded' };
  }
  if (strategy === 'stash') {
    const stashBefore = await git(['rev-parse', '--verify', '--quiet', 'refs/stash']).catch(() => '');
    await git(['stash', 'push', '--include-untracked', '-m', 'dispatch: local changes set aside by self-update'], 60_000);
    const stashAfter = await git(['rev-parse', '--verify', '--quiet', 'refs/stash']).catch(() => '');
    const stashed = Boolean(stashAfter) && stashAfter !== stashBefore;
    try {
      await advance();
    } catch (e) {
      if (stashed) await git(['stash', 'pop'], 60_000).catch(() => {}); // put things back; entry survives if even this fails
      throw e;
    }
    if (!stashed) return { localChanges: 'restored' }; // race: tree turned out clean
    try {
      await git(['stash', 'pop'], 60_000);
      return { localChanges: 'restored' };
    } catch {
      // Pop hit conflicts — it keeps the stash entry but litters the tree with
      // conflict markers. Clear the half-applied state; the changes are safe in stash.
      await git(['reset', '--hard'], 30_000);
      return { localChanges: 'stashed' };
    }
  }
  throw new Error(`unsupported update strategy: ${strategy || 'none'}`);
}

export async function checkUpdateStatus({ git }) {
  const checkedAt = new Date().toISOString();
  const localRef = 'refs/heads/main';
  const remoteRef = 'refs/remotes/origin/main';
  try {
    await git(['fetch', '--quiet', 'origin', 'main']);
    await git(['rev-parse', '--verify', '--quiet', localRef]);
    await git(['rev-parse', '--verify', '--quiet', remoteRef]);
    const behindOut = await git(['rev-list', '--count', `${localRef}..${remoteRef}`]);
    const aheadOut = await git(['rev-list', '--count', `${remoteRef}..${localRef}`]);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
    const { behind, ahead } = parseAheadBehind(behindOut, aheadOut);
    const state = behind > 0 ? 'update-available' : 'up-to-date';
    return { behind, ahead, branch, state, error: null, checkedAt, localRef, remoteRef };
  } catch (e) {
    return {
      behind: 0,
      ahead: 0,
      branch: null,
      state: 'status-error',
      error: formatGitUpdateError(e),
      checkedAt,
      localRef,
      remoteRef,
    };
  }
}
