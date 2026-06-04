import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newMnemonic,
  accountFromMnemonic,
  deriveAddresses,
  newPrivateKey,
  accountFromPrivateKey,
} from '../src/keyvault.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';
const KNOWN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

test('newMnemonic returns a 12-word mnemonic', () => {
  const mnemonic = newMnemonic();
  assert.equal(typeof mnemonic, 'string');
  assert.equal(mnemonic.trim().split(/\s+/).length, 12);
});

test('known mnemonic derives the well-known address at index 0', () => {
  const account = accountFromMnemonic(KNOWN_MNEMONIC, 0);
  assert.equal(account.address, KNOWN_ADDRESS);
});

test('accountFromMnemonic defaults to index 0', () => {
  const account = accountFromMnemonic(KNOWN_MNEMONIC);
  assert.equal(account.address, KNOWN_ADDRESS);
});

test('deriveAddresses returns distinct, indexed addresses', () => {
  const count = 5;
  const derived = deriveAddresses(KNOWN_MNEMONIC, count);
  assert.equal(derived.length, count);

  derived.forEach((entry, i) => {
    assert.equal(entry.index, i);
    assert.match(entry.address, /^0x[0-9a-fA-F]{40}$/);
  });

  // index 0 matches the well-known address
  assert.equal(derived[0].address, KNOWN_ADDRESS);

  // all addresses are distinct
  const unique = new Set(derived.map((e) => e.address));
  assert.equal(unique.size, count);
});

test('private-key round-trip yields a valid 0x address', () => {
  const pk = newPrivateKey();
  assert.match(pk, /^0x[0-9a-fA-F]{64}$/);

  const account = accountFromPrivateKey(pk);
  assert.match(account.address, /^0x[0-9a-fA-F]{40}$/);
});
