import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkUpdateStatus, createGitRunner, parseAheadBehind } from '../engine/update-status.mjs';

test('parseAheadBehind normalizes git rev-list counts', () => {
  assert.deepEqual(parseAheadBehind('3\n', '0\n'), { behind: 3, ahead: 0 });
  assert.deepEqual(parseAheadBehind('', ''), { behind: 0, ahead: 0 });
  assert.deepEqual(parseAheadBehind('x', 'y'), { behind: 0, ahead: 0 });
});

test('checkUpdateStatus degrades silently outside a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-status-'));
  try {
    const status = await checkUpdateStatus({ git: createGitRunner(dir) });
    assert.equal(status.behind, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.branch, null);
    assert.ok(status.error);
    assert.ok(status.checkedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
