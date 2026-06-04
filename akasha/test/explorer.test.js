import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBlock,
  formatTx,
  formatAddressSummary,
  shortHash,
} from '../src/explorer.js';

import { getAddress } from 'viem';
// Lowercase inputs; expected = viem's canonical EIP-55 checksum (the formatter's invariant).
const LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const LOWER2 = '0x8617e340b3d01fa5f11f306f4090fd50e238070d';
const CHECKSUM = getAddress(LOWER);
const CHECKSUM2 = getAddress(LOWER2);

test('formatBlock renders ISO timestamp + decimal counts (bigint inputs)', () => {
  const out = formatBlock({
    number: 123n,
    hash: '0xabc',
    timestamp: 1700000000n, // 2023-11-14T22:13:20.000Z
    transactions: ['0xaa', '0xbb', '0xcc'],
    gasUsed: 21000n,
    gasLimit: 30000000n,
  });

  assert.equal(out.number, '123');
  assert.equal(out.hash, '0xabc');
  assert.equal(out.timestamp, '2023-11-14T22:13:20.000Z');
  // ISO-8601 UTC sanity check.
  assert.match(out.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(out.txCount, '3');
  assert.equal(out.gasUsed, '21000');
  assert.equal(out.gasLimit, '30000000');
});

test('formatBlock accepts hex-quantity (RPC) inputs', () => {
  const out = formatBlock({
    number: '0x10', // 16
    hash: '0xdef',
    timestamp: '0x654b8c80', // 1699449984
    transactions: '0x2', // numeric tx count, not an array
    gasUsed: '0x5208', // 21000
    gasLimit: '0x1c9c380', // 30000000
  });

  assert.equal(out.number, '16');
  assert.equal(out.txCount, '2');
  assert.equal(out.gasUsed, '21000');
  assert.equal(out.gasLimit, '30000000');
  assert.equal(out.timestamp, new Date(1699449984 * 1000).toISOString());
});

test('formatTx formats value via formatEther and checksums addresses', () => {
  const out = formatTx({
    hash: '0xdeadbeef',
    from: LOWER,
    to: LOWER2,
    value: 1500000000000000000n, // 1.5 PRANA
    nonce: 7n,
    gasPrice: 20000000000n, // 20 gwei
  });

  assert.equal(out.hash, '0xdeadbeef');
  assert.equal(out.from, CHECKSUM);
  assert.equal(out.to, CHECKSUM2);
  assert.equal(out.valuePrana, '1.5');
  assert.equal(out.nonce, '7');
  assert.equal(out.gasPriceGwei, '20');
});

test('formatTx handles hex inputs and null `to` (contract creation)', () => {
  const out = formatTx({
    hash: '0xc0ffee',
    from: LOWER,
    to: null,
    value: '0xde0b6b3a7640000', // 1 PRANA (1e18)
    nonce: '0x0',
    gasPrice: '0x3b9aca00', // 1 gwei
  });

  assert.equal(out.to, null);
  assert.equal(out.from, CHECKSUM);
  assert.equal(out.valuePrana, '1');
  assert.equal(out.nonce, '0');
  assert.equal(out.gasPriceGwei, '1');
});

test('shortHash truncates correctly', () => {
  const h =
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  assert.equal(shortHash(h), '0x1234…cdef');
});

test('shortHash leaves short strings unchanged', () => {
  assert.equal(shortHash('0x1234'), '0x1234');
  assert.equal(shortHash('0x12345678'), '0x12345678'); // exactly 10 chars
});

test('shortHash rejects non-0x input', () => {
  assert.throws(() => shortHash('1234abcd'), /0x-prefixed/);
  assert.throws(() => shortHash(1234), /0x-prefixed/);
});

test('formatAddressSummary checksums + formats balance', () => {
  const out = formatAddressSummary({
    address: LOWER,
    balanceWei: 2500000000000000000n, // 2.5 PRANA
    txCount: 42n,
  });

  assert.equal(out.address, CHECKSUM);
  assert.equal(out.balancePrana, '2.5');
  assert.equal(out.txCount, '42');
});

test('formatAddressSummary accepts hex balance + count', () => {
  const out = formatAddressSummary({
    address: CHECKSUM,
    balanceWei: '0x0',
    txCount: '0x10', // 16
  });

  assert.equal(out.address, CHECKSUM);
  assert.equal(out.balancePrana, '0');
  assert.equal(out.txCount, '16');
});
