// Tests for the model registry: docs parsing, capability→effort mapping, union/apply
// semantics, and cache round-trip. Run with `npm test` (node:test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelIds, effortsFromCapabilities, applyModels } from '../registry.mjs';

/* ---------- parseModelIds: docs-scrape fallback must reject page junk ---------- */

test('parseModelIds(claude) extracts real ids and rejects junk', () => {
  const html = `
    claude-fable-5 claude-opus-4-8 claude-sonnet-5 claude-haiku-4-5-20251001
    claude-opus-47                          <!-- truncated slug from a heading anchor -->
    claude-haiku-4-5-20251001-v1:0          <!-- bedrock variant -->
    claude-fable-5-and-claude-mythos-5      <!-- url slug -->
    claude-mythos-5`;
  const ids = parseModelIds('claude', html);
  assert.ok(ids.includes('claude-fable-5'));
  assert.ok(ids.includes('claude-opus-4-8'));
  assert.ok(ids.includes('claude-haiku-4-5-20251001'));
  assert.ok(ids.includes('claude-mythos-5'));
  assert.ok(!ids.includes('claude-opus-47'), 'truncated slug must be rejected');
  assert.ok(!ids.some((i) => i.includes('-v1')), 'bedrock variants must be rejected');
});

test('parseModelIds(codex) extracts gpt ids and rejects filenames', () => {
  const html = `gpt-5.5 GPT-5.6 gpt-5.6-sol gpt-5.6-terra.webp gpt-5.4.jpg gpt-5.4-mini gpt-5.3-codex-spark`;
  const ids = parseModelIds('codex', html);
  assert.ok(ids.includes('gpt-5.5'));
  assert.ok(ids.includes('gpt-5.6'));
  assert.ok(ids.includes('gpt-5.6-sol'));
  assert.ok(ids.includes('gpt-5.4-mini'));
  assert.ok(ids.includes('gpt-5.3-codex-spark'));
  assert.ok(!ids.some((i) => i.endsWith('.webp') || i.endsWith('.jpg')), 'image filenames must be rejected');
});

/* ---------- effortsFromCapabilities: Anthropic capabilities → ordered efforts ---------- */

test('effortsFromCapabilities maps supported levels in canonical order', () => {
  const caps = { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } };
  assert.deepEqual(effortsFromCapabilities(caps), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('effortsFromCapabilities: partial support filters levels', () => {
  const caps = { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } } };
  assert.deepEqual(effortsFromCapabilities(caps), ['low', 'high']);
});

test('effortsFromCapabilities: unsupported or missing → empty (model takes no effort param)', () => {
  assert.deepEqual(effortsFromCapabilities({ effort: { supported: false } }), []);
  assert.deepEqual(effortsFromCapabilities({}), []);
  assert.deepEqual(effortsFromCapabilities(undefined), []);
});

/* ---------- applyModels: authoritative replace + in-use survival ---------- */

function fakeRegistry() {
  return {
    codex: {
      models: [
        { id: 'gpt-5.5', label: 'gpt-5.5' },
        { id: 'gpt-5.2', label: 'gpt-5.2' }, // provider retired this one
      ],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      meta: { source: 'seed', fetchedAt: null },
    },
  };
}

test('applyModels replaces the list with the authoritative set', () => {
  const reg = fakeRegistry();
  applyModels(reg, 'codex', [{ id: 'gpt-5.5', label: 'gpt-5.5', efforts: ['low', 'xhigh'], defaultEffort: 'medium' }], 'codex-app-server');
  assert.equal(reg.codex.models.length, 1);
  assert.equal(reg.codex.models[0].efforts.length, 2);
  assert.equal(reg.codex.meta.source, 'codex-app-server');
  assert.ok(reg.codex.meta.fetchedAt, 'fetchedAt stamped');
});

test('applyModels keeps retired models that are still in use, marked stale', () => {
  const reg = fakeRegistry();
  applyModels(reg, 'codex', [{ id: 'gpt-5.5', label: 'gpt-5.5' }], 'codex-app-server', new Set(['gpt-5.2']));
  const retired = reg.codex.models.find((m) => m.id === 'gpt-5.2');
  assert.ok(retired, 'in-use retired model survives');
  assert.equal(retired.stale, true);
});

test('applyModels drops retired models that are NOT in use', () => {
  const reg = fakeRegistry();
  applyModels(reg, 'codex', [{ id: 'gpt-5.5', label: 'gpt-5.5' }], 'codex-app-server', new Set());
  assert.ok(!reg.codex.models.some((m) => m.id === 'gpt-5.2'));
});
