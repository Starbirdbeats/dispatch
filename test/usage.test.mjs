import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../engine/codex.mjs';
import { parseLine as parseClaudeLine } from '../engine/claude.mjs';
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

test('parseLine treats turn.completed usage as cumulative in/out, never as context', () => {
  const state = {};
  const event = {
    type: 'turn.completed',
    usage: { input_tokens: 39_863_169, cached_input_tokens: 38_684_416, output_tokens: 89_027, reasoning_output_tokens: 22_139 },
  };
  const ev = parseLine(JSON.stringify(event), state);
  assert.equal(ev.kind, 'result');
  assert.equal(state.usage.contextTokens, null); // cumulative ≠ context — no fake "100% full"
  assert.equal(state.usage.inputTokens, 39_863_169);
  assert.equal(state.usage.cachedInputTokens, 38_684_416);
  assert.equal(state.usage.outputTokens, 89_027);
});

test('parseLine prefers last-turn usage for context and keeps totals for in/out', () => {
  const state = {};
  const event = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 5_000_000, cached_input_tokens: 4_800_000, output_tokens: 40_000 },
        last_token_usage: { total_tokens: 130_000, reasoning_output_tokens: 10_000 },
        model_context_window: 272_000,
      },
    },
  };
  assert.equal(parseLine(JSON.stringify(event), state), null);
  assert.equal(state.usage.contextTokens, 120_000); // last turn minus reasoning output
  assert.equal(state.usage.windowTokens, 272_000);
  assert.equal(state.usage.inputTokens, 5_000_000);
  assert.equal(state.usage.outputTokens, 40_000);
});

test('turn.completed keeps a context reading captured earlier in the stream', () => {
  const state = {};
  parseLine(JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 90_000 }, model_context_window: 272_000 } },
  }), state);
  parseLine(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 2_000_000, cached_input_tokens: 1_900_000, output_tokens: 30_000 },
  }), state);
  assert.equal(state.usage.contextTokens, 90_000);
  assert.equal(state.usage.windowTokens, 272_000);
  assert.equal(state.usage.inputTokens, 2_000_000);
});

test('claude parseLine counts repeated per-block usage once and splits in/out', () => {
  const state = {};
  const usage = { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 1_000, output_tokens: 20 };
  const line = JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'fable', usage, content: [] } });
  parseClaudeLine(line, state); // same message re-emitted per content block
  parseClaudeLine(line, state);
  assert.equal(state.usage.inputTokens, 1_510);
  assert.equal(state.usage.cachedInputTokens, 1_000);
  assert.equal(state.usage.outputTokens, 20);
  assert.equal(state.usage.contextTokens, 1_530);

  parseClaudeLine(JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_2', model: 'fable', usage: { input_tokens: 5, cache_read_input_tokens: 1_500, output_tokens: 40 }, content: [] },
  }), state);
  assert.equal(state.usage.inputTokens, 3_015);
  assert.equal(state.usage.outputTokens, 60);
});

test('claude result usage overrides accumulated totals but keeps the context reading', () => {
  const state = {};
  parseClaudeLine(JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', model: 'fable', usage: { input_tokens: 100, output_tokens: 10 }, content: [] },
  }), state);
  parseClaudeLine(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 28, cache_creation_input_tokens: 78_899, cache_read_input_tokens: 762_116, output_tokens: 16_636 },
  }), state);
  assert.equal(state.usage.inputTokens, 841_043);
  assert.equal(state.usage.cachedInputTokens, 762_116);
  assert.equal(state.usage.outputTokens, 16_636);
  assert.equal(state.usage.contextTokens, 110); // last live reading survives
});

test('contextSnapshot passes through in/out totals and allows totals-only snapshots', () => {
  const snap = contextSnapshot({
    contextTokens: null, windowTokens: 272_000, model: 'gpt-5.5', at: '2026-07-18T06:00:00.000Z',
    inputTokens: 39_863_169.4, cachedInputTokens: 38_684_416, outputTokens: 89_027,
  });
  assert.equal(snap.contextTokens, null);
  assert.equal(snap.pct, null);
  assert.equal(snap.windowTokens, 272_000);
  assert.equal(snap.inputTokens, 39_863_169);
  assert.equal(snap.outputTokens, 89_027);
  assert.equal(contextSnapshot({ model: 'x', at: 'now' }), null);
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
