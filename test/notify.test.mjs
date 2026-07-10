import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramConfig, renderMessage } from '../engine/notify.mjs';

function withEnv(env, fn) {
  const prev = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    DISPATCH_PUBLIC_URL: process.env.DISPATCH_PUBLIC_URL,
    DISPATCH_PORT: process.env.DISPATCH_PORT,
  };
  for (const k of Object.keys(prev)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('telegramConfig defaults missing telegram settings to disabled events-on config', () => {
  withEnv({}, () => {
    const cfg = telegramConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.token, '');
    assert.equal(cfg.chatId, '');
    assert.deepEqual(cfg.events, { completed: true, intervention: true });
    assert.equal(cfg.baseUrl, 'http://localhost:4400');
  });
});

test('telegramConfig requires enabled flag plus token and chat id', () => {
  withEnv({}, () => {
    assert.equal(telegramConfig({ telegram: { enabled: true, chatId: '123' } }).enabled, false);
    assert.equal(telegramConfig({ telegram: { enabled: true, token: 'tok' } }).enabled, false);
    assert.equal(telegramConfig({ telegram: { enabled: false, token: 'tok', chatId: '123' } }).enabled, false);
    assert.equal(telegramConfig({ telegram: { enabled: true, token: 'tok', chatId: '123' } }).enabled, true);
  });
});

test('telegramConfig lets env credentials override settings and preserves event toggles', () => {
  withEnv({ TELEGRAM_BOT_TOKEN: 'env-token', TELEGRAM_CHAT_ID: 'env-chat', DISPATCH_PUBLIC_URL: 'https://dispatch.test' }, () => {
    const cfg = telegramConfig({
      telegram: {
        enabled: true,
        token: 'settings-token',
        chatId: 'settings-chat',
        events: { completed: false },
      },
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.token, 'env-token');
    assert.equal(cfg.chatId, 'env-chat');
    assert.deepEqual(cfg.events, { completed: false, intervention: true });
    assert.equal(cfg.baseUrl, 'https://dispatch.test');
  });
});

test('renderMessage formats completed tickets with title, column, duration, and link', () => {
  const msg = renderMessage(
    'completed',
    { id: 't-1', title: 'Ship alert', durationMs: 65_000 },
    { name: 'Done' },
    'https://dispatch.test',
  );
  assert.match(msg, /DONE/);
  assert.match(msg, /Ship alert/);
  assert.match(msg, /landed in Done/);
  assert.match(msg, /took 1m 5s/);
  assert.match(msg, /https:\/\/dispatch\.test\/#t-1/);
});

test('renderMessage formats intervention tickets and truncates long reasons', () => {
  const detail = `${'a'.repeat(400)}bbbb`;
  const msg = renderMessage(
    'intervention',
    { id: 't-2', title: 'Needs review', status: 'awaiting-human', stuckReason: { detail } },
    { name: 'Build' },
    'https://dispatch.test',
  );
  assert.match(msg, /NEEDS YOU/);
  assert.match(msg, /Needs review/);
  assert.match(msg, /Build · awaiting-human/);
  assert.ok(msg.includes('a'.repeat(400)));
  assert.ok(!msg.includes('bbbb'));
  assert.match(msg, /https:\/\/dispatch\.test\/#t-2/);
});
