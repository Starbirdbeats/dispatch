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
      error: e.message || String(e),
      checkedAt,
      localRef,
      remoteRef,
    };
  }
}
