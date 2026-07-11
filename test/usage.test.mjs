import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextSnapshot } from '../engine/limits.mjs';
import { codexRateLimitWindows, normalizePercent, normalizeUsageWindow } from '../engine/usage.mjs';

test('normalizePercent treats low percentage values as percentages, not fractions', () => {
  assert.equal(normalizePercent(0.5), 0.5);
  assert.equal(normalizePercent(1), 1);
  assert.equal(normalizePercent(37), 37);
  assert.equal(normalizePercent(120), 100);
  assert.equal(normalizePercent('nope'), null);
});

test('normalizeUsageWindow preserves already-normalized used percentages', () => {
  assert.deepEqual(normalizeUsageWindow({ usedPct: 1, resetsAt: '2026-07-11T10:00:00.000Z' }), {
    usedPct: 1,
    resetsAt: '2026-07-11T10:00:00.000Z',
  });
  assert.equal(normalizeUsageWindow({ usedPercent: 0.7 })?.usedPct, 0.7);
  assert.equal(normalizeUsageWindow({ used_percent: 99.95 })?.usedPct, 100);
});

test('codexRateLimitWindows classifies windows by duration, not primary/secondary names', () => {
  const windows = codexRateLimitWindows({
    primary: { usedPercent: 0.7, windowDurationMins: 10080, resetsAt: '2026-07-18T06:00:00.000Z' },
    secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: '2026-07-11T11:00:00.000Z' },
  });
  assert.equal(windows.weekly.usedPct, 0.7);
  assert.equal(windows.fiveHour.usedPct, 12);
});

test('codexRateLimitWindows supports stream field names and relative reset seconds', () => {
  const windows = codexRateLimitWindows({
    primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 60 },
  }, { at: '2026-07-11T06:00:00.000Z' });
  assert.equal(windows.fiveHour.usedPct, 42);
  assert.equal(windows.fiveHour.resetsAt, '2026-07-11T06:01:00.000Z');
});

test('contextSnapshot reports rounded tokens and clamps occupancy percentage', () => {
  assert.deepEqual(contextSnapshot({ contextTokens: 50.4, windowTokens: 200, model: 'm', at: '2026-07-11T06:00:00.000Z' }), {
    contextTokens: 50,
    windowTokens: 200,
    model: 'm',
    pct: 25.2,
    at: '2026-07-11T06:00:00.000Z',
  });
  assert.equal(contextSnapshot({ contextTokens: 300, windowTokens: 200 })?.pct, 100);
  assert.equal(contextSnapshot({ contextTokens: -5, windowTokens: 200 })?.pct, 0);
  assert.equal(contextSnapshot({ contextTokens: 1, windowTokens: 0 }), null);
});
