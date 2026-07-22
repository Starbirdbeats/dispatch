import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { authLaunchError, firstDeviceCode, firstUrl, createAuthSessions } from '../engine/authflow.mjs';

function writeScript(binDir, name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// A fake `claude` whose `auth login` prints the URL on stdout, waits for a code on stdin,
// and exits 0 only for the expected code (mirrors the real subscription flow).
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
  echo "Paste code here if prompted > "
  read code
  if [ "$code" = "good-code#state" ]; then exit 0; fi
  echo "invalid code" 1>&2
  exit 1
fi
exit 1
`;

// A fake Codex device login: it prints a browser-independent URL + code, then polls.
const FAKE_CODEX = `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Open https://auth.openai.com/codex/device" 1>&2
  echo "Enter this one-time code: TEST-CODE" 1>&2
  sleep 30
fi
exit 1
`;

async function withPath(binDir, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${binDir}:${prev}`;
  try { return await fn(); } finally { process.env.PATH = prev; }
}

function settledPromise() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, onSettled: (type, info) => resolve({ type, ...info }) };
}

test('firstUrl extracts the first https URL and ignores noise', () => {
  assert.equal(firstUrl('visit: https://claude.com/x?y=1 now'), 'https://claude.com/x?y=1');
  assert.equal(firstUrl('nav to https://auth.openai.com/a?b=c\nOn a remote machine? use --device-auth'), 'https://auth.openai.com/a?b=c');
  assert.equal(firstUrl('no url here'), null);
  assert.equal(firstUrl(''), null);
  // stops at whitespace/quotes/brackets, not mid-query
  assert.equal(firstUrl('("https://x.dev/a=1")'), 'https://x.dev/a=1');
});

test('firstDeviceCode extracts a Codex device code without mistaking other ids', () => {
  assert.equal(firstDeviceCode('Enter this one-time code:\nABCD-1234'), 'ABCD-1234');
  assert.equal(firstDeviceCode('version 1.2.3; id 12345678-abcd-1234-abcd-1234567890ab'), null);
  assert.equal(firstDeviceCode('no device code'), null);
});

test('codex device session exposes the URL and code as structured state', async () => {
  let invocation = null;
  const spawnProcess = (cmd, args) => {
    invocation = { cmd, args };
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.kill = () => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        queueMicrotask(() => proc.emit('exit', 0));
      }
      return true;
    };
    queueMicrotask(() => {
      proc.stderr.write('Open https://auth.openai.com/codex/device\n');
      proc.stderr.write('Enter this one-time code: ABCD-1234\n');
    });
    return proc;
  };
  const sessions = createAuthSessions({ spawnProcess, urlWaitMs: 1000 });
  const started = await sessions.start('codex');
  assert.deepEqual(invocation, { cmd: 'codex', args: ['login', '--device-auth'] });
  assert.equal(started.url, 'https://auth.openai.com/codex/device');
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(sessions.snapshot().pending.codex.userCode, 'ABCD-1234');
  sessions.cancel('codex');
  sessions.disposeAll();
});

test('launch errors turn process codes into actionable setup guidance', async () => {
  assert.equal(authLaunchError('codex', new Error('spawn EPERM')), 'Codex CLI could not be started');
  assert.doesNotMatch(authLaunchError('codex', new Error('spawn EPERM')), /EPERM/);
  assert.equal(authLaunchError('claude', new Error('spawn ENOENT')), 'Claude Code CLI is not installed');

  const denied = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  const sessions = createAuthSessions({ spawnProcess: () => { throw denied; } });
  await assert.rejects(() => sessions.start('codex'), /CLI could not be started/i);
  assert.equal(sessions.snapshot().errors.codex, 'Codex CLI could not be started');
  sessions.disposeAll();
});

test('claude session: captures URL, forwards code to stdin, settles ok on exit 0', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-claude-'));
  try {
    writeScript(bin, 'claude', FAKE_CLAUDE);
    await withPath(bin, async () => {
      const { promise, onSettled } = settledPromise();
      const sessions = createAuthSessions({ onSettled, urlWaitMs: 4000, timeoutMs: 20000 });

      const started = await sessions.start('claude');
      assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth/);
      assert.equal(started.needsCode, true);
      assert.equal(started.command, 'claude auth login');
      assert.deepEqual(Object.keys(sessions.snapshot().pending), ['claude']);

      assert.equal(sessions.submitCode('claude', 'good-code#state'), true);
      const settled = await promise;
      assert.equal(settled.type, 'claude');
      assert.equal(settled.code, 0);
      assert.equal(settled.error, null);
      assert.deepEqual(sessions.snapshot().pending, {}); // cleared after settle
      sessions.disposeAll();
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('claude session: wrong code exits non-zero and records an error', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-badcode-'));
  try {
    writeScript(bin, 'claude', FAKE_CLAUDE);
    await withPath(bin, async () => {
      const { promise, onSettled } = settledPromise();
      const sessions = createAuthSessions({ onSettled, urlWaitMs: 4000 });
      await sessions.start('claude');
      sessions.submitCode('claude', 'WRONG');
      const settled = await promise;
      assert.notEqual(settled.code, 0);
      assert.match(settled.error, /exited with code/i);
      assert.match(sessions.snapshot().errors.claude, /exited with code/i);
      sessions.disposeAll();
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('codex session: captures device URL + code from STDERR, then cancel kills it', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-codex-'));
  try {
    writeScript(bin, 'codex', FAKE_CODEX);
    await withPath(bin, async () => {
      const sessions = createAuthSessions({ urlWaitMs: 4000, timeoutMs: 20000 });
      const started = await sessions.start('codex');
      assert.equal(started.url, 'https://auth.openai.com/codex/device');
      assert.equal(started.userCode, 'TEST-CODE');
      assert.equal(started.needsCode, false);
      assert.equal(started.command, 'codex login --device-auth');
      assert.equal(sessions.snapshot().pending.codex.url, started.url);
      assert.equal(sessions.snapshot().pending.codex.userCode, 'TEST-CODE');

      assert.equal(sessions.cancel('codex'), true);
      assert.deepEqual(sessions.snapshot().pending, {});
      sessions.disposeAll();
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('restarting browser sign-in returns the same in-flight session (idempotent)', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-idem-'));
  try {
    writeScript(bin, 'codex', FAKE_CODEX);
    await withPath(bin, async () => {
      const sessions = createAuthSessions({ urlWaitMs: 4000 });
      const a = await sessions.start('codex');
      const b = await sessions.start('codex');
      assert.equal(b.alreadyRunning, true);
      assert.equal(a.url, b.url);
      sessions.disposeAll();
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('start throws a helpful error when the CLI is missing', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-missing-'));
  try {
    // empty bin dir; scope PATH to it so `codex` can't resolve
    const prev = process.env.PATH;
    process.env.PATH = bin;
    try {
      const sessions = createAuthSessions({ urlWaitMs: 2000 });
      await assert.rejects(() => sessions.start('codex'), /CLI is not installed/i);
      sessions.disposeAll();
    } finally { process.env.PATH = prev; }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('start rejects an unknown provider', async () => {
  const sessions = createAuthSessions();
  await assert.rejects(() => sessions.start('bogus'), /unknown provider/i);
  sessions.disposeAll();
});

test('session that never prints a URL times out with a run-it-manually message', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'authflow-nourl-'));
  try {
    // prints nothing to either stream, just blocks
    writeScript(bin, 'codex', '#!/bin/sh\nif [ "$1" = "login" ]; then sleep 30; fi\n');
    await withPath(bin, async () => {
      const sessions = createAuthSessions({ urlWaitMs: 800, timeoutMs: 20000 });
      await assert.rejects(() => sessions.start('codex'), /did not provide a sign-in URL/i);
      assert.deepEqual(sessions.snapshot().pending, {}); // killed, not left dangling
      sessions.disposeAll();
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('submitCode with no active session throws a clear message', async () => {
  const sessions = createAuthSessions();
  assert.throws(() => sessions.submitCode('claude', 'x'), /no login in progress/i);
  sessions.disposeAll();
});
