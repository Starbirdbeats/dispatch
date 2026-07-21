import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_OAUTH_TOKEN_EXPIRED,
  CLAUDE_OAUTH_TOKEN_MISSING,
  ClaudeOAuthTokenError,
  isClaudeOAuthTokenUnavailable,
  probe,
  readClaudeOAuthToken,
} from '../registry.mjs';

async function withSandbox(env, fn) {
  // Snapshot the env-key fallbacks too so a key set in the outer environment can't leak
  // into a "logged out" assertion (and gets restored afterwards).
  const keys = ['HOME', 'PATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function writeScript(binDir, name, body) {
  const file = path.join(binDir, name);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function setupFakeClaude(dir, token = 'fake-token-abc') {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const creds = {
    claudeAiOauth: {
      accessToken: token,
      expiresAt: Date.now() + 60_000,
    },
  };
  fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify(creds), 'utf8');
}

function captureThrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected function to throw');
}

test('readClaudeOAuthToken uses CLAUDE_CODE_OAUTH_TOKEN when provided', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-token-env-'));
  try {
    await withSandbox({ HOME: home, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: ' env-token-abc ' }, async () => {
      assert.equal(readClaudeOAuthToken(), 'env-token-abc');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readClaudeOAuthToken reports an empty credentials token as missing', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-token-missing-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0 } }), 'utf8');
    await withSandbox({ HOME: home, PATH: process.env.PATH }, async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const err = captureThrown(() => readClaudeOAuthToken());
      assert.ok(err instanceof ClaudeOAuthTokenError);
      assert.equal(err.code, CLAUDE_OAUTH_TOKEN_MISSING);
      assert.doesNotMatch(err.message, /fake-token|env-token/i);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readClaudeOAuthToken reports an expired credentials token separately', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-token-expired-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'expired-token', expiresAt: Date.now() - 1000 } }), 'utf8');
    await withSandbox({ HOME: home, PATH: process.env.PATH }, async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const err = captureThrown(() => readClaudeOAuthToken());
      assert.ok(err instanceof ClaudeOAuthTokenError);
      assert.equal(err.code, CLAUDE_OAUTH_TOKEN_EXPIRED);
      assert.equal(isClaudeOAuthTokenUnavailable(err), true);
      assert.doesNotMatch(err.message, /expired-token/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('probe reports installed+authenticated CLI states when both providers are present', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-auth-'));
  const bin = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-bin-'));
  try {
    writeScript(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 1.0.0"; fi\n');
    writeScript(bin, 'codex', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 2.0"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "You are logged in as test@example.com"; fi\n');
    setupFakeClaude(home);

    await withSandbox({
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    }, async () => {
      const status = await probe();
      assert.equal(status.claude.installed, true);
      assert.equal(status.claude.authenticated, true);
      assert.equal(status.claude.version, 'claude 1.0.0');
      assert.equal(status.codex.installed, true);
      assert.equal(status.codex.authenticated, true);
      assert.equal(status.codex.version, 'codex 2.0');
      assert.equal(status.codex.error, null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('probe keeps provider installation/auth checks independent and degrades on partial failures', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-fail-'));
  const bin = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-bin-'));

  try {
    setupFakeClaude(home);
    writeScript(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 1.0.0"; fi\n');
    // no codex executable -> should be marked as not installed but claude auth remains valid
    await withSandbox({
      HOME: home,
      PATH: bin,
    }, async () => {
      const status = await probe();
      assert.equal(status.claude.installed, true);
      assert.equal(status.claude.authenticated, true);
      assert.equal(status.codex.installed, false);
      assert.equal(status.codex.authenticated, false);
      assert.ok(typeof status.codex.error === 'string');
      assert.match(status.codex.error, /not found|command not found|ENOENT/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('probe reads codex auth from stderr (modern codex-cli prints status there)', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-codex-'));
  const bin = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-bin-'));
  try {
    // No claude here; codex prints its "logged in" line to STDERR and exits 0.
    writeScript(bin, 'codex', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 2.0"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT" 1>&2; exit 0; fi\n');
    await withSandbox({ HOME: home, PATH: bin }, async () => {
      const status = await probe();
      assert.equal(status.codex.installed, true);
      assert.equal(status.codex.authenticated, true, 'codex auth must be read from stderr');
      assert.match(status.codex.authDetail, /logged in/i);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('probe reports claude authenticated from `auth status` even when the token file is empty', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-claude-ok-'));
  const bin = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-bin-'));
  try {
    // Modern Claude Code: token lives in the keyring, so .credentials.json has an EMPTY
    // accessToken. `claude auth status --json` is the source of truth.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0 } }), 'utf8');
    writeScript(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 2.1.0"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":true,"authMethod":"claudeAiOauth","apiProvider":"firstParty"}\'; exit 0; fi\n');
    await withSandbox({ HOME: home, PATH: bin }, async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const status = await probe();
      assert.equal(status.claude.installed, true);
      assert.equal(status.claude.authenticated, true, 'claude auth must come from `auth status`, not the empty token file');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('probe reports claude NOT authenticated when `auth status` says logged out (non-zero exit)', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-claude-out-'));
  const bin = mkdtempSync(path.join(os.tmpdir(), 'dispatch-probe-bin-'));
  try {
    // No credentials file; `claude auth status --json` prints the verdict on stdout and
    // exits 1 (the CLI's real behavior when logged out).
    writeScript(bin, 'claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 2.1.0"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\'; exit 1; fi\n');
    await withSandbox({ HOME: home, PATH: bin }, async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const status = await probe();
      assert.equal(status.claude.installed, true);
      assert.equal(status.claude.authenticated, false);
      assert.equal(status.claude.authDetail, 'not authenticated');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
