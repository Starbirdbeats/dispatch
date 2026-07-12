import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteEnvKey,
  envEntries,
  parseEnv,
  serializeEnvValue,
  upsertEnvValue,
  validateEnvKey,
} from '../engine/envfile.mjs';

test('parseEnv reads plain, exported, quoted, and commented values', () => {
  const parsed = parseEnv(`
# comment
PLAIN=abc
export TOKEN="a=b#c"
SINGLE=' spaced value '
URL=https://example.test/path#fragment
INLINE=kept # comment
`);
  const values = Object.fromEntries(parsed.entries.map((e) => [e.key, e.value]));
  assert.equal(values.PLAIN, 'abc');
  assert.equal(values.TOKEN, 'a=b#c');
  assert.equal(values.SINGLE, ' spaced value ');
  assert.equal(values.URL, 'https://example.test/path#fragment');
  assert.equal(values.INLINE, 'kept');
});

test('serializeEnvValue leaves simple tokens plain and quotes unsafe values', () => {
  assert.equal(serializeEnvValue('abc_123-./:@'), 'abc_123-./:@');
  assert.equal(serializeEnvValue('a b'), '"a b"');
  assert.equal(serializeEnvValue('line\nnext'), '"line\\nnext"');
  assert.equal(serializeEnvValue('a"b'), '"a\\"b"');
});

test('upsertEnvValue updates duplicate keys into one active row', () => {
  const next = upsertEnvValue('A=1\nB=2\nA=old\n', 'A', 'new value');
  assert.equal(next, 'A="new value"\nB=2\n');
  const entries = parseEnv(next).entries.filter((e) => e.key === 'A');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'new value');
});

test('upsertEnvValue appends missing keys and preserves comments', () => {
  const next = upsertEnvValue('# keep\nA=1\n', 'B', 'two');
  assert.equal(next, '# keep\nA=1\nB=two\n');
});

test('deleteEnvKey removes all matching entries only', () => {
  const next = deleteEnvKey('A=1\nB=2\nA=3\n', 'A');
  assert.equal(next, 'B=2\n');
});

test('validateEnvKey rejects invalid names', () => {
  assert.equal(validateEnvKey('GOOD_1'), 'GOOD_1');
  assert.throws(() => validateEnvKey('1BAD'), /invalid env key/);
  assert.throws(() => validateEnvKey('BAD-NAME'), /invalid env key/);
});

test('envEntries hides ephemeral runtime-noise keys but keeps file + real keys', () => {
  const file = path.join(os.tmpdir(), `dispatch-env-${process.pid}-${Date.now()}-test.env`);
  fs.writeFileSync(file, 'PWD=fromfile\nMY_TOKEN=secret\n');
  try {
    const runtime = { _: '/usr/bin/node', PWD: '/runtime/dir', OLDPWD: '/x', SHLVL: '2', RUNTIME_ONLY: 'keepme' };
    const byKey = Object.fromEntries(envEntries(file, runtime).map((e) => [e.key, e]));
    // pure shell noise that is runtime-only is filtered out
    assert.ok(!('_' in byKey), '`_` should be hidden');
    assert.ok(!('OLDPWD' in byKey), 'OLDPWD should be hidden');
    assert.ok(!('SHLVL' in byKey), 'SHLVL should be hidden');
    // a noise-named key that also lives in .env still shows (file entry wins)
    assert.equal(byKey.PWD?.inFile, true);
    assert.equal(byKey.PWD?.value, 'fromfile');
    // real keys are untouched
    assert.equal(byKey.MY_TOKEN?.value, 'secret');
    assert.equal(byKey.RUNTIME_ONLY?.value, 'keepme');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
