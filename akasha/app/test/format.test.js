// Tests for the pure display formatters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrana,
  formatPranaWithSymbol,
  parsePranaToWei,
  truncateAddress,
  truncateHash,
  timeAgo,
  formatTimestamp,
  hexToNumber,
  formatGas,
} from '../src/lib/format.js';

test('formatPrana: whole and fractional wei', () => {
  assert.equal(formatPrana(0n), '0');
  assert.equal(formatPrana(10n ** 18n), '1');
  assert.equal(formatPrana(1500000000000000000n), '1.5');
  assert.equal(formatPrana(10n ** 18n + 1n, 18), '1.000000000000000001');
  // trailing zeros trimmed
  assert.equal(formatPrana(1230000000000000000n), '1.23');
  // hex string input
  assert.equal(formatPrana('0xde0b6b3a7640000'), '1'); // 1e18
  // negative
  assert.equal(formatPrana(-(10n ** 18n)), '-1');
  // junk
  assert.equal(formatPrana(undefined), '—');
});

test('formatPrana: maxDecimals truncation', () => {
  // 1.123456789 PRANA, ask for 6 places
  assert.equal(formatPrana(1123456789000000000n, 6), '1.123456');
});

test('formatPranaWithSymbol', () => {
  assert.equal(formatPranaWithSymbol(10n ** 18n), '1 PRANA');
});

test('parsePranaToWei: round-trips formatPrana', () => {
  assert.equal(parsePranaToWei('1'), 10n ** 18n);
  assert.equal(parsePranaToWei('1.5'), 1500000000000000000n);
  assert.equal(parsePranaToWei('0.000000000000000001'), 1n);
  assert.equal(parsePranaToWei('.5'), 500000000000000000n);
  assert.equal(parsePranaToWei('10'), 10n ** 19n);
  assert.throws(() => parsePranaToWei('abc'));
  assert.throws(() => parsePranaToWei('1.2.3'));
  assert.throws(() => parsePranaToWei('1.1234567890123456789')); // >18 dp
});

test('truncateAddress / truncateHash', () => {
  const a = '0x1234567890abcdef1234567890abcdef12345678';
  assert.equal(truncateAddress(a), '0x1234…5678');
  assert.equal(truncateHash('0x' + 'a'.repeat(64)), '0xaaaaaaaa…aaaaaaaa');
  // short / non-address passthrough
  assert.equal(truncateAddress('0x12'), '0x12');
  assert.equal(truncateAddress(''), '');
});

test('timeAgo: deterministic with injected now', () => {
  const now = 1_000_000_000_000; // fixed ms
  const t = (deltaSec) => timeAgo((now / 1000) - deltaSec, now);
  assert.equal(t(0), 'just now');
  assert.equal(t(30), '30s ago');
  assert.equal(t(120), '2m ago');
  assert.equal(t(3 * 3600), '3h ago');
  assert.equal(t(2 * 86400), '2d ago');
  assert.equal(timeAgo((now / 1000) + 100, now), 'in the future');
  assert.equal(timeAgo(0, now), '—');
});

test('formatTimestamp', () => {
  // 2021-09-09T01:46:40Z ish — just assert shape & UTC suffix
  const s = formatTimestamp(1_631_152_000);
  assert.match(s, /UTC$/);
  assert.equal(formatTimestamp(0), '—');
});

test('hexToNumber and formatGas', () => {
  assert.equal(hexToNumber('0x5'), 5);
  assert.equal(hexToNumber('0x21'), 33);
  assert.equal(formatGas('0x5208'), '21,000');
  assert.equal(formatGas(undefined), '—');
});
