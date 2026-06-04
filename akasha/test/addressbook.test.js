import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressBook } from '../src/addressbook.js';

// A valid address in lowercase; its EIP-55 checksummed form differs in case.
const LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';

test('add + get returns the checksummed address', () => {
  const book = new AddressBook();
  const returned = book.add('alice', LOWER);
  assert.equal(returned, CHECKSUM);
  assert.equal(book.get('alice'), CHECKSUM);
});

test('invalid address throws', () => {
  const book = new AddressBook();
  assert.throws(() => book.add('bob', '0xnot-an-address'), /invalid address/);
  assert.throws(() => book.add('bob', 'hello'), /invalid address/);
});

test('duplicate name throws', () => {
  const book = new AddressBook();
  book.add('alice', LOWER);
  assert.throws(() => book.add('alice', CHECKSUM), /duplicate name/);
});

test('remove works', () => {
  const book = new AddressBook();
  book.add('alice', LOWER);
  assert.equal(book.remove('alice'), true);
  assert.equal(book.get('alice'), undefined);
  assert.equal(book.remove('alice'), false);
  assert.deepEqual(book.list(), []);
});

test('list returns array of {name,address}', () => {
  const book = new AddressBook();
  book.add('alice', LOWER);
  assert.deepEqual(book.list(), [{ name: 'alice', address: CHECKSUM }]);
});

test('findByAddress is case-insensitive', () => {
  const book = new AddressBook();
  book.add('alice', LOWER);
  const byLower = book.findByAddress(LOWER);
  const byUpper = book.findByAddress(CHECKSUM);
  const byChecksum = book.findByAddress(book.get('alice'));
  assert.deepEqual(byLower, { name: 'alice', address: CHECKSUM });
  assert.deepEqual(byUpper, { name: 'alice', address: CHECKSUM });
  assert.deepEqual(byChecksum, { name: 'alice', address: CHECKSUM });
  assert.equal(book.findByAddress('0x0000000000000000000000000000000000000000'), undefined);
});

test('toJSON / fromJSON round-trips', () => {
  const book = new AddressBook();
  book.add('alice', LOWER);
  book.add('bob', '0xde709f2102306220921060314715629080e2fb77');
  const json = book.toJSON();
  // Survive a serialize/deserialize cycle.
  const restored = AddressBook.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(restored.list(), book.list());
  assert.equal(restored.get('alice'), CHECKSUM);
});
