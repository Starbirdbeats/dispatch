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
