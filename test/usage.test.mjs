import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../engine/codex.mjs';
import { contextSnapshot } from '../engine/limits.mjs';
import {
  buildProviderUsage,
  codexRateLimitWindows,
  extractCodexRateLimitsSnapshot,
  normalizePercent,
  normalizeUsageWindow,
} from '../engine/usage.mjs';

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

test('buildProviderUsage stores non-error notes separately from errors', () => {
  const state = buildProviderUsage({ plan: 'max' }, {
    at: '2026-07-11T10:00:00.000Z',
    source: 'claude-cli-auth',
    note: 'usage unavailable',
  });
  assert.equal(state.plan, 'max');
  assert.equal(state.source, 'claude-cli-auth');
  assert.equal(state.note, 'usage unavailable');
  assert.equal(state.error, undefined);

  const errorState = buildProviderUsage({}, {
    source: 'claude-oauth-usage',
    note: 'will be suppressed',
    error: 'usage API 401',
  });
  assert.equal(errorState.error, 'usage API 401');
  assert.equal(errorState.note, undefined);
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

test('extractCodexRateLimitsSnapshot reads the codex rateLimitsByLimitId entry', () => {
  const windows = extractCodexRateLimitsSnapshot({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: '2026-07-11T11:00:00.000Z' },
        secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: '2026-07-18T11:00:00.000Z' },
      },
    },
  });
  assert.equal(windows.fiveHour.usedPct, 18);
  assert.equal(windows.weekly.usedPct, 6);
});

test('extractCodexRateLimitsSnapshot falls back to non-codex rateLimitsByLimitId entries', () => {
  const windows = extractCodexRateLimitsSnapshot({
    rateLimitsByLimitId: {
      other: {
        primary: { used_percent: 31, window_minutes: 300, resets_at: '2026-07-11T11:00:00.000Z' },
        secondary: { used_percent: 9, window_minutes: 10080, resets_at: '2026-07-18T11:00:00.000Z' },
      },
    },
  });
  assert.equal(windows.fiveHour.usedPct, 31);
  assert.equal(windows.weekly.usedPct, 9);
});

test('extractCodexRateLimitsSnapshot accepts rateLimits primary and secondary without durations', () => {
  const windows = extractCodexRateLimitsSnapshot({
    rateLimits: {
      primary: { usedPercent: 44, resetsAt: '2026-07-11T11:00:00.000Z' },
      secondary: { usedPercent: 12, resetsAt: '2026-07-18T11:00:00.000Z' },
    },
  });
  assert.equal(windows.fiveHour.usedPct, 44);
  assert.equal(windows.weekly.usedPct, 12);
});

test('extractCodexRateLimitsSnapshot accepts bare primary and secondary snapshots', () => {
  const windows = extractCodexRateLimitsSnapshot({
    primary: { used_percentage: 51, resets_at: '2026-07-11T11:00:00.000Z' },
    secondary: { used_percentage: 21, resets_at: '2026-07-18T11:00:00.000Z' },
  });
  assert.equal(windows.fiveHour.usedPct, 51);
  assert.equal(windows.weekly.usedPct, 21);
});

test('parseLine captures rate limits from thread token usage updates', () => {
  const state = {};
  const event = {
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        total: { totalTokens: 42 },
        modelContextWindow: 1000,
      },
      rateLimits: {
        primary: { used_percent: 23, window_minutes: 300 },
      },
    },
  };
  assert.equal(parseLine(JSON.stringify(event), state), null);
  assert.deepEqual(state.rateLimits, event.params.rateLimits);
  assert.equal(state.usage.contextTokens, 42);
});

test('parseLine captures rate limits from event_msg token counts', () => {
  const state = {};
  const rateLimits = {
    limit_id: 'codex',
    primary: { used_percent: 19, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  };
  const event = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: 99 },
        model_context_window: 1000,
      },
      rate_limits: rateLimits,
    },
  };
  assert.equal(parseLine(JSON.stringify(event), state), null);
  assert.deepEqual(state.rateLimits, rateLimits);
  assert.equal(state.usage.contextTokens, 99);
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
