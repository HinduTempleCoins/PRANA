// Tests for lib/vesting-builder.mjs — vesting + streaming param builders.
// Validates schedule constraints and the exact arg order each contract expects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { buildVesting, buildStream } from '../lib/vesting-builder.mjs';

const TOKEN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BEN = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ZERO = '0x0000000000000000000000000000000000000000';

// The real VestingFactory + StreamingPayments signatures (must match args order).
const factoryIface = new Interface([
  'function createVesting(address token, address beneficiary, uint64 start, uint64 cliffSeconds, uint64 duration, uint256 total) returns (address)',
]);
const streamIface = new Interface([
  'function createStream(address recipient, address token, uint256 total, uint64 start, uint64 stop) returns (uint256)',
]);

// ---- vesting ----------------------------------------------------------------

test('buildVesting: valid linear vest with cliff returns correct args + derived times', () => {
  const v = buildVesting({
    token: TOKEN,
    beneficiary: BEN,
    start: 1000,
    cliffSeconds: 100,
    duration: 400,
    total: 1_000_000n,
  });
  assert.equal(v.kind, 'vesting');
  assert.equal(v.method, 'createVesting');
  assert.deepEqual(v.args, [TOKEN, BEN, 1000n, 100n, 400n, 1_000_000n]);
  assert.equal(v.cliffTimestamp, 1100n);
  assert.equal(v.endTimestamp, 1400n);
  assert.deepEqual(v.requiresApproval, { token: TOKEN, spender: 'factory', amount: 1_000_000n });
  // args must encode cleanly against the real factory signature
  assert.doesNotThrow(() => factoryIface.encodeFunctionData('createVesting', v.args));
});

test('buildVesting: cliffSeconds defaults to 0 (no cliff)', () => {
  const v = buildVesting({ token: TOKEN, beneficiary: BEN, start: 0, duration: 100, total: 50n });
  assert.equal(v.args[3], 0n);
  assert.equal(v.cliffTimestamp, 0n);
});

test('buildVesting: rejects duration 0, cliff>duration, zero total, bad/zero addresses', () => {
  assert.throws(() => buildVesting({ token: TOKEN, beneficiary: BEN, start: 0, duration: 0, total: 1n }), /duration must be > 0/);
  assert.throws(
    () => buildVesting({ token: TOKEN, beneficiary: BEN, start: 0, cliffSeconds: 200, duration: 100, total: 1n }),
    /cliffSeconds must be <= duration/,
  );
  assert.throws(() => buildVesting({ token: TOKEN, beneficiary: BEN, start: 0, duration: 100, total: 0n }), /total must be > 0/);
  assert.throws(() => buildVesting({ token: '0xbad', beneficiary: BEN, start: 0, duration: 1, total: 1n }), /not a valid address/);
  assert.throws(() => buildVesting({ token: ZERO, beneficiary: BEN, start: 0, duration: 1, total: 1n }), /zero address/);
});

// ---- streaming --------------------------------------------------------------

test('buildStream: valid stream returns args in (recipient, token, total, start, stop) order', () => {
  const s = buildStream({ recipient: BEN, token: TOKEN, total: 1000n, start: 100, stop: 1100 });
  assert.equal(s.kind, 'stream');
  assert.equal(s.method, 'createStream');
  // NOTE the arg order differs from vesting: recipient, token, total, start, stop
  assert.deepEqual(s.args, [BEN, TOKEN, 1000n, 100n, 1100n]);
  assert.equal(s.duration, 1000n);
  assert.equal(s.ratePerSecond, 1n); // 1000 / 1000s
  assert.deepEqual(s.requiresApproval, { token: TOKEN, spender: 'streaming', amount: 1000n });
  assert.doesNotThrow(() => streamIface.encodeFunctionData('createStream', s.args));
});

test('buildStream: enforces stop>start and even divisibility (per-second exactness)', () => {
  assert.throws(() => buildStream({ recipient: BEN, token: TOKEN, total: 1000n, start: 100, stop: 100 }), /stop must be > start/);
  assert.throws(() => buildStream({ recipient: BEN, token: TOKEN, total: 1000n, start: 200, stop: 100 }), /stop must be > start/);
  // 1001 not divisible by 1000s
  assert.throws(
    () => buildStream({ recipient: BEN, token: TOKEN, total: 1001n, start: 0, stop: 1000 }),
    /evenly divisible/,
  );
});

test('buildStream: rejects zero total, bad/zero recipient, and recipient==contract', () => {
  assert.throws(() => buildStream({ recipient: BEN, token: TOKEN, total: 0n, start: 0, stop: 10 }), /total must be > 0/);
  assert.throws(() => buildStream({ recipient: ZERO, token: TOKEN, total: 10n, start: 0, stop: 10 }), /zero address/);
  assert.throws(
    () => buildStream({ recipient: BEN, token: TOKEN, total: 10n, start: 0, stop: 10, streamingContract: BEN }),
    /must not be the streaming contract/,
  );
});

test('buildStream: ratePerSecond is exact for evenly divisible totals', () => {
  const s = buildStream({ recipient: BEN, token: TOKEN, total: 3600n, start: 0, stop: 60 });
  assert.equal(s.ratePerSecond, 60n);
  assert.equal(s.duration, 60n);
});
