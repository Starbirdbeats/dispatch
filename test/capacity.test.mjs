import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendConcurrency } from '../engine/capacity.mjs';

test('low cold-build disk clamps recommendation to one and reports disk starvation', () => {
  const result = recommendConcurrency({ cores: 4, ramGB: 46, freeGB: 7, sharedCache: false });

  assert.equal(result.recommended, 1);
  assert.equal(result.limitedBy, 'disk');
  assert.equal(result.starved, true);
  assert.deepEqual(result.limits, { cpu: 2, ram: 5, disk: 0 });
});

test('shared cargo cache reduces disk pressure so cpu can become the limit', () => {
  const result = recommendConcurrency({ cores: 4, ramGB: 46, freeGB: 46, sharedCache: true });

  assert.equal(result.recommended, 2);
  assert.equal(result.limitedBy, 'cpu');
  assert.equal(result.starved, false);
  assert.deepEqual(result.limits, { cpu: 2, ram: 5, disk: 4 });
});

test('recommendation is capped at the settings ceiling', () => {
  const result = recommendConcurrency({ cores: 64, ramGB: 512, freeGB: 2000, sharedCache: true });

  assert.equal(result.recommended, 8);
  assert.equal(result.starved, false);
});

test('missing disk capacity leaves cpu and ram as the only constraints', () => {
  const result = recommendConcurrency({ cores: 12, ramGB: 24, freeGB: null, sharedCache: false });

  assert.equal(result.recommended, 3);
  assert.equal(result.limitedBy, 'ram');
  assert.deepEqual(result.limits, { cpu: 6, ram: 3 });
});
