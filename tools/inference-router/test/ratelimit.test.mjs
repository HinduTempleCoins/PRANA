// node:test — TokenBucket (TASK XX19). Deterministic via injected `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/ratelimit.mjs';

// A controllable fake clock so refill is testable with no real time/timers.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('starts full and consumes tokens', () => {
  const clk = fakeClock();
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clk.now });
  assert.equal(b.available(), 3);
  assert.equal(b.tryRemove(1), true);
  assert.equal(b.tryRemove(2), true);
  assert.equal(b.available(), 0);
});

test('rejects when empty (removes nothing)', () => {
  const clk = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clk.now });
  assert.equal(b.tryRemove(2), true);
  assert.equal(b.tryRemove(1), false); // empty -> rejected
  assert.equal(b.available(), 0); // still empty, nothing removed by the failed call
});

test('refills over time at refillPerSec, capped at capacity', () => {
  const clk = fakeClock();
  const b = new TokenBucket({ capacity: 5, refillPerSec: 2, now: clk.now });
  // drain it
  assert.equal(b.tryRemove(5), true);
  assert.equal(b.available(), 0);
  // 1s -> +2 tokens
  clk.advance(1000);
  assert.equal(b.available(), 2);
  assert.equal(b.tryRemove(2), true);
  // 10s -> would be +20 but capped at capacity 5
  clk.advance(10_000);
  assert.equal(b.available(), 5);
});

test('partial refill (fractional seconds)', () => {
  const clk = fakeClock();
  const b = new TokenBucket({ capacity: 10, refillPerSec: 4, now: clk.now });
  b.tryRemove(10);
  clk.advance(500); // 0.5s * 4 = 2 tokens
  assert.equal(b.available(), 2);
});

test('refillPerSec 0 means never refills', () => {
  const clk = fakeClock();
  const b = new TokenBucket({ capacity: 1, refillPerSec: 0, now: clk.now });
  assert.equal(b.tryRemove(1), true);
  clk.advance(1_000_000);
  assert.equal(b.available(), 0);
});

test('validates constructor args', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSec: 1 }));
  assert.throws(() => new TokenBucket({ capacity: 1, refillPerSec: -1 }));
});
