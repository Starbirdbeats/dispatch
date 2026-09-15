import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the browser uses a secure WebSocket from an HTTPS page', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /location\.protocol === 'https:' \? 'wss:' : 'ws:'/,
  );
});
