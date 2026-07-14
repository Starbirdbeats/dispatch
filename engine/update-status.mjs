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
  try {
    await git(['fetch', '--quiet', 'origin', 'main']);
    await git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
    await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
    const behindOut = await git(['rev-list', '--count', 'refs/heads/main..refs/remotes/origin/main']);
    const aheadOut = await git(['rev-list', '--count', 'refs/remotes/origin/main..refs/heads/main']);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
    const { behind, ahead } = parseAheadBehind(behindOut, aheadOut);
    return { behind, ahead, branch, error: null, checkedAt };
  } catch (e) {
    return { behind: 0, ahead: 0, branch: null, error: e.message || String(e), checkedAt };
  }
}
