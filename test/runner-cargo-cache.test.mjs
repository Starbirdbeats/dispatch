import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cargoTargetForTicket, runEnv } from '../engine/runner.mjs';

test('Cargo targets are isolated and path-safe per ticket', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cargo-target-'));
  try {
    assert.equal(
      cargoTargetForTicket('../ticket with spaces', {}, dataDir),
      path.join(dataDir, 'cargo-targets', '_ticket_with_spaces'),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run environment uses disk-efficient automated Cargo defaults', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cargo-env-'));
  try {
    const env = runEnv('t-123', null, { HOME: '/tmp/test-home', PATH: '' }, dataDir);
    assert.equal(env.CARGO_TARGET_DIR, path.join(dataDir, 'cargo-targets', 't-123'));
    assert.equal(env.CARGO_INCREMENTAL, '0');
    assert.equal(env.CARGO_PROFILE_DEV_DEBUG, '0');
    assert.equal(env.CARGO_PROFILE_TEST_DEBUG, '0');
    assert.equal(env.SCCACHE_CACHE_SIZE, '15G');
    assert.equal(env.RUSTC_WRAPPER, undefined);
    assert.equal(fs.existsSync(env.CARGO_TARGET_DIR), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('explicit Cargo settings continue to override Dispatch defaults', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cargo-override-'));
  try {
    const env = runEnv('t-123', null, {
      HOME: '/tmp/test-home',
      PATH: '',
      CARGO_TARGET_DIR: path.join(dataDir, 'operator-target'),
      CARGO_INCREMENTAL: '1',
      CARGO_PROFILE_TEST_DEBUG: '1',
      RUSTC_WRAPPER: '/custom/wrapper',
    }, dataDir);
    assert.equal(env.CARGO_TARGET_DIR, path.join(dataDir, 'operator-target'));
    assert.equal(env.CARGO_INCREMENTAL, '1');
    assert.equal(env.CARGO_PROFILE_TEST_DEBUG, '1');
    assert.equal(env.RUSTC_WRAPPER, '/custom/wrapper');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
