// Tests for lib/address-book.mjs — encrypted contacts, cheap scrypt params.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressBook } from '../lib/address-book.mjs';
import { createMemoryStorage } from '../lib/storage-fs.mjs';

const FAST = { N: 1 << 10, r: 8, p: 1 };

const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const A_LC = A.toLowerCase();
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('add / get / list with checksum normalization', () => {
  const book = new AddressBook({ scrypt: FAST });
  const e = book.add('Alice', A_LC, 'main account');
  assert.equal(e.address, A); // checksummed
  assert.equal(book.get('alice').address, A); // case-insensitive name
  assert.equal(book.get('Alice').note, 'main account');

  book.add('Bob', B);
  assert.deepEqual(book.list().map((c) => c.name), ['Alice', 'Bob']);
});

test('duplicate name and invalid address are rejected', () => {
  const book = new AddressBook({ scrypt: FAST });
  book.add('Alice', A);
  assert.throws(() => book.add('alice', B), /duplicate/);
  assert.throws(() => book.add('Carol', '0x1234'), /invalid address/);
  assert.throws(() => book.add('', A), /non-empty/);
});

test('remove and findByAddress', () => {
  const book = new AddressBook({ scrypt: FAST });
  book.add('Alice', A);
  book.add('Bob', B);
  assert.equal(book.findByAddress(A_LC).name, 'Alice');
  assert.equal(book.remove('alice'), true);
  assert.equal(book.remove('nope'), false);
  assert.equal(book.findByAddress(A), undefined);
  assert.equal(book.list().length, 1);
});

test('search matches name, note and address', () => {
  const book = new AddressBook({ scrypt: FAST });
  book.add('Alice', A, 'exchange wallet');
  book.add('Bob', B, 'cold storage');
  assert.deepEqual(book.search('ali').map((c) => c.name), ['Alice']);
  assert.deepEqual(book.search('cold').map((c) => c.name), ['Bob']);
  assert.deepEqual(book.search(A.slice(0, 8)).map((c) => c.name), ['Alice']);
  // empty query returns everything
  assert.equal(book.search('').length, 2);
});

test('encrypted export/import round-trip', async () => {
  const book = new AddressBook({ scrypt: FAST });
  book.add('Alice', A, 'note A');
  book.add('Bob', B);

  const env = await book.exportEncrypted('secret');
  assert.equal(env.kdf.name, 'scrypt');
  // ciphertext must not contain a plaintext address
  assert.ok(!JSON.stringify(env).toLowerCase().includes(A_LC));

  const book2 = new AddressBook({ scrypt: FAST });
  await book2.importEncrypted(env, 'secret');
  assert.deepEqual(
    book2.list().map((c) => ({ name: c.name, address: c.address })),
    [{ name: 'Alice', address: A }, { name: 'Bob', address: B }],
  );
  assert.equal(book2.get('Alice').note, 'note A');
});

test('import with wrong password rejects', async () => {
  const book = new AddressBook({ scrypt: FAST });
  book.add('Alice', A);
  const env = await book.exportEncrypted('right');
  const book2 = new AddressBook({ scrypt: FAST });
  await assert.rejects(() => book2.importEncrypted(env, 'wrong'), /incorrect password/i);
});

test('save / load through storage interface', async () => {
  const storage = createMemoryStorage();
  const book = new AddressBook({ storage, scrypt: FAST });
  book.add('Alice', A, 'hi');
  await book.save('pw');

  // the stored blob is encrypted (no plaintext address)
  const blob = await storage.loadBlob();
  assert.ok(!blob.toLowerCase().includes(A_LC));

  const fresh = new AddressBook({ storage, scrypt: FAST });
  const loaded = await fresh.load('pw');
  assert.equal(loaded, true);
  assert.equal(fresh.get('Alice').address, A);
  assert.equal(fresh.get('Alice').note, 'hi');

  // wrong password on load rejects
  const bad = new AddressBook({ storage, scrypt: FAST });
  await assert.rejects(() => bad.load('nope'), /incorrect password/i);
});

test('load returns false when nothing stored', async () => {
  const fresh = new AddressBook({ storage: createMemoryStorage(), scrypt: FAST });
  assert.equal(await fresh.load('pw'), false);
});
