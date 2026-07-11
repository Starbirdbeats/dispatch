import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probe } from '../registry.mjs';

async function withSandbox(env, fn) {
  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    process.env.HOME = prev.HOME;
    process.env.PATH = prev.PATH;
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
