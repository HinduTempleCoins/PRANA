import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunSummary, SCORE_BASE, postRun } from '../src/data/runVoucher.js';

// In plain `node --test`, CRYPTO_BUILD resolves to false (the __CRYPTO_BUILD__ define is
// absent), so postRun collapses to the neutral clean-build stub — no network, no fixture,
// no voucher payload (the whole settlement path is dead-code in the clean build).
test('postRun returns the neutral stub in the (test = clean) build', async () => {
  const v = await postRun({ finished: true, timeMs: 12345, distance: 0, trackHash: '0xabc' });
  assert.deepEqual(v, { stub: true });
});

test('buildRunSummary inverts time for a finished run (faster => higher score)', () => {
  const fast = buildRunSummary({ finished: true, timeMs: 5000, distance: 0, trackHash: '0x1' });
  const slow = buildRunSummary({ finished: true, timeMs: 9000, distance: 0, trackHash: '0x1' });
  assert.equal(fast.score, SCORE_BASE - 5000);
  assert.ok(fast.score > slow.score, 'faster run scores higher');
  assert.equal(fast.gameId, 'ley-rider');
  assert.equal(fast.runRef, '0x1');
});

test('buildRunSummary uses distance for an unfinished run', () => {
  const s = buildRunSummary({ finished: false, timeMs: 0, distance: 742.6, trackHash: '0x2' });
  assert.equal(s.score, 743);
  assert.equal(s.finished, false);
});

test('buildRunSummary never produces a negative score', () => {
  const s = buildRunSummary({ finished: true, timeMs: SCORE_BASE + 99999, distance: 0, trackHash: '0x3' });
  assert.equal(s.score, 0);
});
