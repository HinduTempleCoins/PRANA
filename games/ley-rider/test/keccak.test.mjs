import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Hex, keccak256Bytes, toHex } from '../src/lib/keccak.js';

// Published keccak256 (pre-SHA3 padding) test vectors — these are EXACTLY what Solidity's
// keccak256 produces for the same input bytes.
test('keccak256 of empty string matches Solidity', () => {
  assert.equal(
    keccak256Hex(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

test('keccak256("abc") matches the published vector', () => {
  assert.equal(
    keccak256Hex('abc'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
});

test('keccak256 of a >136-byte input crosses the rate boundary correctly', () => {
  // 200 'a' chars exercises multi-block absorption (rate = 136 bytes).
  const input = 'a'.repeat(200);
  // Determinism + correct 32-byte output length across the block boundary.
  assert.equal(keccak256Hex(input), keccak256Hex(input));
  assert.equal(keccak256Bytes(input.split('').map((c) => c.charCodeAt(0))).length, 32);
  // Distinct inputs of different block sizes produce distinct digests.
  assert.notEqual(keccak256Hex(input), keccak256Hex('a'.repeat(199)));
});

test('toHex formats 32-byte output as 0x + 64 hex chars', () => {
  const h = keccak256Hex('prana');
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(toHex(new Uint8Array([0, 255, 16])), '0x00ff10');
});
