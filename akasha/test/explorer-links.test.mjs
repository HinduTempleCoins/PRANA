// Tests for lib/explorer-links.mjs — EIP-3091 link builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explorerLink,
  blockLink,
  txLink,
  addressLink,
  tokenLink,
  networkFromMetadata,
} from '../lib/explorer-links.mjs';

const BASE = 'https://explorer.prana.network';
const TX = '0x' + 'a'.repeat(64);
// lowercase address — getAddress should checksum it in the output.
const ADDR_LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ADDR_CHECKSUM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// --- happy-path table -------------------------------------------------------

const cases = [
  ['block by number', () => explorerLink(BASE, { block: 12345 }), `${BASE}/block/12345`],
  ['block by bigint', () => explorerLink(BASE, { block: 12345n }), `${BASE}/block/12345`],
  ['block by hex string', () => explorerLink(BASE, { block: '0x10' }), `${BASE}/block/16`],
  ['tx', () => explorerLink(BASE, { tx: TX }), `${BASE}/tx/${TX}`],
  ['address (checksummed)', () => explorerLink(BASE, { address: ADDR_LOWER }), `${BASE}/address/${ADDR_CHECKSUM}`],
  ['token (checksummed)', () => explorerLink(BASE, { token: ADDR_LOWER }), `${BASE}/token/${ADDR_CHECKSUM}`],
  ['blockLink helper', () => blockLink(BASE, 7), `${BASE}/block/7`],
  ['txLink helper', () => txLink(BASE, TX), `${BASE}/tx/${TX}`],
  ['addressLink helper', () => addressLink(BASE, ADDR_LOWER), `${BASE}/address/${ADDR_CHECKSUM}`],
  ['tokenLink helper', () => tokenLink(BASE, ADDR_LOWER), `${BASE}/token/${ADDR_CHECKSUM}`],
];

for (const [name, fn, expected] of cases) {
  test(`explorerLink: ${name}`, () => {
    assert.equal(fn(), expected);
  });
}

// --- trailing slash safety --------------------------------------------------

test('trailing slashes on base are stripped', () => {
  assert.equal(explorerLink('https://x.io/', { block: 1 }), 'https://x.io/block/1');
  assert.equal(explorerLink('https://x.io///', { block: 1 }), 'https://x.io/block/1');
});

// --- validation -------------------------------------------------------------

test('rejects non-http base', () => {
  assert.throws(() => explorerLink('ftp://x.io', { block: 1 }), /http/);
  assert.throws(() => explorerLink('', { block: 1 }), /non-empty/);
});

test('rejects bad tx hash', () => {
  assert.throws(() => explorerLink(BASE, { tx: '0x123' }), /invalid transaction hash/);
  assert.throws(() => explorerLink(BASE, { tx: 'a'.repeat(64) }), /invalid transaction hash/);
});

test('rejects bad address checksum', () => {
  // Mixed-case but wrong checksum should throw via getAddress.
  assert.throws(() => explorerLink(BASE, { address: '0xF39fd6e51aad88f6f4ce6ab8827279cfffb92266' }));
});

test('rejects negative / non-integer block', () => {
  assert.throws(() => explorerLink(BASE, { block: -1 }), /non-negative/);
  assert.throws(() => explorerLink(BASE, { block: 1.5 }), /integer/);
});

test('requires exactly one target key', () => {
  assert.throws(() => explorerLink(BASE, {}), /exactly one/);
  assert.throws(() => explorerLink(BASE, { block: 1, tx: TX }), /exactly one/);
});

// --- networkFromMetadata ----------------------------------------------------

test('networkFromMetadata builds an add-chain config with PRANA defaults', () => {
  const cfg = networkFromMetadata({ explorerUrl: 'https://explorer.prana.network/' });
  assert.equal(cfg.chainId, '0x1a751');
  assert.equal(cfg.chainName, 'PRANA');
  assert.equal(cfg.nativeCurrency.symbol, 'PRANA');
  assert.equal(cfg.nativeCurrency.decimals, 18);
  assert.deepEqual(cfg.blockExplorerUrls, ['https://explorer.prana.network']); // slash stripped
  assert.deepEqual(cfg.rpcUrls, ['http://127.0.0.1:8545']);
});
