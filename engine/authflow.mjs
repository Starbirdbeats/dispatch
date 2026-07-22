// engine/authflow.mjs — subscription OAuth login sessions for provider CLIs.
//
// Dispatch runs under systemd with no DISPLAY, so the CLIs can't pop a browser
// themselves. Instead we spawn the login headless, capture the auth URL the CLI
// prints, and hand it to the web client to open. The two providers then diverge:
//
//   claude auth login  — prints the URL on STDOUT, redirect lands on
//                        platform.claude.com which shows a one-time code; the CLI
//                        waits for that code on STDIN. Works from ANY browser
//                        (phone, laptop) because nothing calls back to this host.
//   codex login --device-auth — prints a URL and device code on STDERR, then polls
//                        until the user enters that code in any browser. This works
//                        when Dispatch is local, remote, or headless.
//
// Session lifecycle: one live session per provider (restarting browser sign-in
// returns the SAME session — the URL embeds a PKCE challenge tied to the process,
// so spawning a fresh one would invalidate the tab the user already has open).
// On exit the server's onSettled hook re-probes so the UI flips to AUTHENTICATED.

import { spawn } from 'node:child_process';

export const AUTH_COMMANDS = {
  claude: { cmd: 'claude', args: ['auth', 'login'], label: 'claude auth login', needsCode: true },
  // Device auth works whether Dispatch is opened on the CLI host or from another
  // computer. The regular browser flow redirects to localhost on the browser machine,
  // which silently fails for remote/headless Dispatch installations.
  codex: { cmd: 'codex', args: ['login', '--device-auth'], label: 'codex login --device-auth', needsCode: false, providesCode: true },
};

const AUTH_PROVIDER_LABELS = { claude: 'Claude Code', codex: 'Codex' };

export function authLaunchError(type, error) {
  const provider = AUTH_PROVIDER_LABELS[type] || type || 'Provider';
  const detail = String(error?.message || error || 'command failed');
  if (/\bENOENT\b|not found/i.test(detail)) {
    return `${provider} CLI is not installed`;
  }
  if (/\b(?:EPERM|EACCES)\b|access is denied|permission denied/i.test(detail)) {
    return `${provider} CLI could not be started`;
  }
  return `${provider} sign-in could not start`;
}

const LOG_CAP = 8 * 1024; // keep enough output for URL + error tails, never unbounded
const URL_WAIT_MS = 10_000; // both CLIs print their URL within ~1s; 10s is generous
const SESSION_TIMEOUT_MS = 15 * 60_000; // abandoned logins die after 15 minutes

export function firstUrl(text) {
  const m = String(text || '').match(/https:\/\/[^\s"'<>)\]]+/);
  return m ? m[0] : null;
}

// Codex device auth prints a short code such as ABCD-1234 on its own line. Keep
// this deliberately strict so version numbers, UUIDs, and URL fragments are ignored.
export function firstDeviceCode(text) {
  const matches = String(text || '').match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/g);
  return matches?.[0] || null;
}

function tail(log, n = 240) {
  const clean = String(log || '').trim().replace(/\s+/g, ' ');
  return clean.length > n ? `…${clean.slice(-n)}` : clean;
}

export function createAuthSessions({ onSettled, urlWaitMs = URL_WAIT_MS, timeoutMs = SESSION_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  const sessions = new Map(); // type -> { proc, url, log, startedAt, timer, cancelled }
  const errors = new Map(); // type -> user-facing message from the LAST failed attempt

  function settle(type, session, code) {
    if (sessions.get(type) === session) sessions.delete(type);
    clearTimeout(session.timer);
    let error = null;
    if (session.cancelled) {
      // user-initiated — not an error state
    } else if (code === 0) {
      errors.delete(type);
    } else {
      error = `${AUTH_COMMANDS[type].label} exited with code ${code}${tail(session.log) ? ` — ${tail(session.log)}` : ''}`;
      errors.set(type, error);
    }
    onSettled?.(type, { code, error, cancelled: session.cancelled });
  }

  async function start(type) {
    const def = AUTH_COMMANDS[type];
    if (!def) throw new Error(`unknown provider: ${type || '(none)'}`);

    // Idempotent: a re-click while a login is pending returns the same URL — a new
    // process would mint a new PKCE challenge and orphan the tab already open.
    const existing = sessions.get(type);
    if (existing && existing.proc.exitCode === null) {
      return { url: existing.url, userCode: existing.userCode, needsCode: def.needsCode, command: def.label, alreadyRunning: true };
    }

    errors.delete(type);
    const session = { proc: null, url: null, userCode: null, log: '', startedAt: new Date().toISOString(), timer: null, cancelled: false, spawnError: null };
    try {
      session.proc = spawnProcess(def.cmd, def.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const msg = authLaunchError(type, e);
      errors.set(type, msg);
      onSettled?.(type, { code: null, error: msg, cancelled: false });
      throw new Error(msg);
    }
    sessions.set(type, session);

    const absorb = (chunk) => {
      session.log = (session.log + chunk).slice(-LOG_CAP);
      if (!session.url) session.url = firstUrl(session.log);
      if (def.providesCode && !session.userCode) session.userCode = firstDeviceCode(session.log);
    };
    session.proc.stdout.on('data', absorb);
    session.proc.stderr.on('data', absorb);
    session.proc.stdin.on('error', () => {}); // EPIPE if CLI dies mid-write; surfaced via exit path
    session.proc.on('error', (e) => {
      // spawn-level failure (ENOENT etc.) — no 'exit' will follow with a code
      if (sessions.get(type) === session) sessions.delete(type);
      clearTimeout(session.timer);
      const msg = authLaunchError(type, e);
      session.spawnError = msg;
      errors.set(type, msg);
      onSettled?.(type, { code: null, error: msg, cancelled: false });
    });
    session.proc.on('exit', (code) => settle(type, session, code));
    session.timer = setTimeout(() => {
      if (session.proc.exitCode === null) {
        session.log += '\n[login timed out after 15 minutes]';
        try { session.proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);

    // Wait for the CLI to print its auth URL (or die trying).
    const deadline = Date.now() + urlWaitMs;
    const ready = () => session.url && (!def.providesCode || session.userCode);
    while (!ready() && Date.now() < deadline) {
      if (session.spawnError) throw new Error(session.spawnError);
      if (session.proc.exitCode !== null) {
        throw new Error(errors.get(type) || `${def.label} exited before printing a login URL — ${tail(session.log) || 'no output'}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!ready()) {
      session.cancelled = true; // suppress the exit-path error; we throw our own
      try { session.proc.kill('SIGKILL'); } catch { /* already gone */ }
      sessions.delete(type);
      const missing = !session.url ? 'a sign-in URL' : 'a device code';
      const msg = `${def.label} did not provide ${missing} in ${Math.round(urlWaitMs / 1000)}s`;
      errors.set(type, msg);
      throw new Error(msg);
    }
    return { url: session.url, userCode: session.userCode, needsCode: def.needsCode, command: def.label, alreadyRunning: false };
  }

  function submitCode(type, code) {
    const session = sessions.get(type);
    if (!session || session.proc.exitCode !== null) {
      throw new Error('no login in progress — select START BROWSER SIGN-IN first, then paste the code');
    }
    const clean = String(code || '').trim();
    if (!clean) throw new Error('paste the code from the browser before submitting');
    session.proc.stdin.write(`${clean}\n`);
    return true;
  }

  function cancel(type) {
    const session = sessions.get(type);
    if (!session) return false;
    session.cancelled = true;
    try { session.proc.kill('SIGKILL'); } catch { /* already gone */ }
    sessions.delete(type);
    return true;
  }

  function snapshot() {
    const pending = {};
    for (const [type, s] of sessions) {
      if (s.proc.exitCode !== null) continue;
      pending[type] = {
        url: s.url,
        userCode: s.userCode,
        needsCode: AUTH_COMMANDS[type].needsCode,
        command: AUTH_COMMANDS[type].label,
        startedAt: s.startedAt,
      };
    }
    return { pending, errors: Object.fromEntries(errors) };
  }

  function disposeAll() {
    for (const [, s] of sessions) {
      s.cancelled = true;
      try { s.proc.kill('SIGKILL'); } catch { /* already gone */ }
      clearTimeout(s.timer);
    }
    sessions.clear();
  }

  return { start, submitCode, cancel, snapshot, disposeAll };
}
