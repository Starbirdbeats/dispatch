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
//   codex login        — prints the URL on STDERR and serves the OAuth callback on
//                        localhost:1455, so the flow self-completes when the
//                        browser is on the same host as Dispatch.
//
// Session lifecycle: one live session per provider (re-clicking AUTHENTICATE
// returns the SAME session — the URL embeds a PKCE challenge tied to the process,
// so spawning a fresh one would invalidate the tab the user already has open).
// On exit the server's onSettled hook re-probes so the UI flips to AUTHENTICATED.

import { spawn } from 'node:child_process';

export const AUTH_COMMANDS = {
  claude: { cmd: 'claude', args: ['auth', 'login'], label: 'claude auth login', needsCode: true },
  codex: { cmd: 'codex', args: ['login'], label: 'codex login', needsCode: false },
};

const LOG_CAP = 8 * 1024; // keep enough output for URL + error tails, never unbounded
const URL_WAIT_MS = 10_000; // both CLIs print their URL within ~1s; 10s is generous
const SESSION_TIMEOUT_MS = 15 * 60_000; // abandoned logins die after 15 minutes

export function firstUrl(text) {
  const m = String(text || '').match(/https:\/\/[^\s"'<>)\]]+/);
  return m ? m[0] : null;
}

function tail(log, n = 240) {
  const clean = String(log || '').trim().replace(/\s+/g, ' ');
  return clean.length > n ? `…${clean.slice(-n)}` : clean;
}

export function createAuthSessions({ onSettled, urlWaitMs = URL_WAIT_MS, timeoutMs = SESSION_TIMEOUT_MS } = {}) {
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
      return { url: existing.url, needsCode: def.needsCode, command: def.label, alreadyRunning: true };
    }

    errors.delete(type);
    const session = { proc: null, url: null, log: '', startedAt: new Date().toISOString(), timer: null, cancelled: false };
    try {
      session.proc = spawn(def.cmd, def.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`could not run ${def.label}: ${e.message}`);
    }
    sessions.set(type, session);

    const absorb = (chunk) => {
      session.log = (session.log + chunk).slice(-LOG_CAP);
      if (!session.url) session.url = firstUrl(session.log);
    };
    session.proc.stdout.on('data', absorb);
    session.proc.stderr.on('data', absorb);
    session.proc.stdin.on('error', () => {}); // EPIPE if CLI dies mid-write; surfaced via exit path
    session.proc.on('error', (e) => {
      // spawn-level failure (ENOENT etc.) — no 'exit' will follow with a code
      if (sessions.get(type) === session) sessions.delete(type);
      clearTimeout(session.timer);
      const msg = /ENOENT/.test(String(e.message))
        ? `${def.cmd} CLI not found on PATH — install it on this host, then retry`
        : `could not run ${def.label}: ${e.message}`;
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
    while (!session.url && Date.now() < deadline) {
      if (session.proc.exitCode !== null) {
        throw new Error(errors.get(type) || `${def.label} exited before printing a login URL — ${tail(session.log) || 'no output'}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!session.url) {
      session.cancelled = true; // suppress the exit-path error; we throw our own
      try { session.proc.kill('SIGKILL'); } catch { /* already gone */ }
      sessions.delete(type);
      const msg = `${def.label} printed no login URL in ${Math.round(urlWaitMs / 1000)}s — run it manually in a terminal, then RE-CHECK`;
      errors.set(type, msg);
      throw new Error(msg);
    }
    return { url: session.url, needsCode: def.needsCode, command: def.label, alreadyRunning: false };
  }

  function submitCode(type, code) {
    const session = sessions.get(type);
    if (!session || session.proc.exitCode !== null) {
      throw new Error('no login in progress — click AUTHENTICATE first, then paste the code');
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
