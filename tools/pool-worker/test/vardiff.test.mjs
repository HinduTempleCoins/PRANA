// vardiff.test.mjs — unit tests for the PR9 vardiff math.
//
// Tested behaviour (switching-worker.md §4):
//  - adjustDifficulty raises difficulty when shares come too FAST, lowers when too SLOW.
//  - bounds are respected (clamp to [min,max]).
//  - the stateful VardiffController CONVERGES so the implied cadence approaches the target,
//    starting from both too-fast and too-slow hardware.
//
// No timers, no I/O — pure math. The controller's solve-time model mirrors hash-lane.mjs:
// t ≈ difficulty / hashrate, so for a fixed hashrate, the difficulty that yields exactly
// targetSeconds is hashrate * targetSeconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustDifficulty, VardiffController } from '../src/vardiff.mjs';

const BOUNDS = { minDifficulty: 1, maxDifficulty: 1_000_000 };

test('adjustDifficulty raises difficulty when shares are too fast', () => {
  const next = adjustDifficulty({
    currentDifficulty: 100,
    observedSeconds: 5, // faster than target -> rarer shares wanted -> raise diff
    targetSeconds: 15,
    ...BOUNDS,
    damping: 1, // full move for a clean assertion
  });
  // ideal = 100 * (15/5) = 300
  assert.equal(next, 300);
});

test('adjustDifficulty lowers difficulty when shares are too slow', () => {
  const next = adjustDifficulty({
    currentDifficulty: 300,
    observedSeconds: 60, // slower than target -> lower diff so small units land shares
    targetSeconds: 15,
    ...BOUNDS,
    damping: 1,
  });
  // ideal = 300 * (15/60) = 75
  assert.equal(next, 75);
});

test('adjustDifficulty clamps to [min,max]', () => {
  const tooHigh = adjustDifficulty({
    currentDifficulty: 900_000,
    observedSeconds: 1,
    targetSeconds: 15,
    ...BOUNDS,
    damping: 1,
  });
  assert.equal(tooHigh, BOUNDS.maxDifficulty, 'clamped at ceiling');

  const tooLow = adjustDifficulty({
    currentDifficulty: 2,
    observedSeconds: 1000,
    targetSeconds: 15,
    ...BOUNDS,
    damping: 1,
  });
  assert.equal(tooLow, BOUNDS.minDifficulty, 'clamped at floor');
});

test('adjustDifficulty rejects invalid inputs', () => {
  assert.throws(() =>
    adjustDifficulty({ currentDifficulty: 0, observedSeconds: 1, targetSeconds: 15, ...BOUNDS }),
  );
  assert.throws(() =>
    adjustDifficulty({ currentDifficulty: 1, observedSeconds: 0, targetSeconds: 15, ...BOUNDS }),
  );
});

// Simulate a worker of fixed hashrate. The "hardware" produces a solve time of
// difficulty/hashrate for whatever difficulty the controller currently sets. We feed that
// back via observe() and check the implied cadence converges toward target.
function simulateConvergence({ hashrate, targetSeconds, steps }) {
  const vc = new VardiffController({
    targetSeconds,
    ...BOUNDS,
    initialDifficulty: 100,
    damping: 0.5,
    window: 1, // no smoothing lag for a tight convergence check
  });
  let lastSolve = 0;
  for (let i = 0; i < steps; i++) {
    const diff = vc.currentTarget();
    lastSolve = diff / hashrate; // the hardware's solve time at this difficulty
    vc.observe(lastSolve);
  }
  return { finalDiff: vc.currentTarget(), lastSolve };
}

test('VardiffController converges to target cadence for a FAST unit', () => {
  // fast GPU: hashrate 50 diff-units/sec; ideal diff for 15s = 750.
  const { lastSolve, finalDiff } = simulateConvergence({
    hashrate: 50,
    targetSeconds: 15,
    steps: 40,
  });
  assert.ok(
    Math.abs(lastSolve - 15) < 0.75,
    `fast unit cadence should approach 15s, got ${lastSolve.toFixed(3)}s (diff=${finalDiff.toFixed(1)})`,
  );
});

test('VardiffController converges to target cadence for a SLOW unit', () => {
  // weak CPU: hashrate 0.5 diff-units/sec; ideal diff for 15s = 7.5.
  const { lastSolve, finalDiff } = simulateConvergence({
    hashrate: 0.5,
    targetSeconds: 15,
    steps: 60,
  });
  assert.ok(
    Math.abs(lastSolve - 15) < 1.5,
    `slow unit cadence should approach 15s, got ${lastSolve.toFixed(3)}s (diff=${finalDiff.toFixed(2)})`,
  );
});

test('VardiffController keeps difficulty within bounds throughout', () => {
  const vc = new VardiffController({ targetSeconds: 15, ...BOUNDS, damping: 0.5 });
  for (let i = 0; i < 50; i++) {
    const d = vc.observe(0.001); // hammer it fast to push toward ceiling
    assert.ok(d >= BOUNDS.minDifficulty && d <= BOUNDS.maxDifficulty);
  }
  for (let i = 0; i < 50; i++) {
    const d = vc.observe(100000); // then very slow to push toward floor
    assert.ok(d >= BOUNDS.minDifficulty && d <= BOUNDS.maxDifficulty);
  }
});
