// ren.test.js — REN name resolution (offline, stub provider). node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRenName, resolveRenName, _internal } from '../src/lib/ren.js';

test('looksLikeRenName: names yes, 0x + junk no', () => {
  assert.equal(looksLikeRenName('ryan.melek'), true);
  assert.equal(looksLikeRenName('A.PRANA'.toLowerCase()), true);
  assert.equal(looksLikeRenName('x.kula'), true);
  assert.equal(looksLikeRenName('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), false);
  assert.equal(looksLikeRenName('nodot'), false);
  assert.equal(looksLikeRenName('bad.tld'), false);
  assert.equal(looksLikeRenName('two.dots.melek'), false);
});

test('encodeResolve has the resolve selector + length word', () => {
  const enc = _internal.encodeResolve('test.melek');
  assert.ok(enc.startsWith('0x461a4478'));
  // offset word (0x20) then length 10 ("test.melek")
  assert.equal(enc.slice(10, 74), (32).toString(16).padStart(64, '0'));
  assert.equal(enc.slice(74, 138), (10).toString(16).padStart(64, '0'));
});

test('resolveRenName decodes the address word from eth_call', async () => {
  const ADDR = 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const provider = { send: async (m, _p) => (m === 'eth_call' ? '0x' + '0'.repeat(24) + ADDR : null) };
  assert.equal((await resolveRenName(provider, 'test.melek')).toLowerCase(), '0x' + ADDR);
});

test('resolveRenName returns null for zero address (unregistered)', async () => {
  const provider = { send: async () => '0x' + '0'.repeat(64) };
  assert.equal(await resolveRenName(provider, 'free.melek'), null);
});

test('resolveRenName soft-fails to null (no throw) on RPC error / non-name', async () => {
  const bad = { send: async () => { throw new Error('rpc down'); } };
  assert.equal(await resolveRenName(bad, 'test.melek'), null);
  assert.equal(await resolveRenName({ send: async () => '0x' }, 'notaname'), null);
});
