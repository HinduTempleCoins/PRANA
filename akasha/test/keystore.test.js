import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encrypt, decrypt, isVault } from '../src/keystore.js';

// A sample PRANA/Anvil dev private key string (DEV ONLY).
const SAMPLE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_PASSPHRASE = 'correct horse battery staple';

test('encrypt → decrypt round-trips a private key string', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  assert.ok(isVault(vault), 'encrypt should produce a valid vault');
  const recovered = await decrypt(vault, TEST_PASSPHRASE);
  assert.equal(recovered, SAMPLE_KEY);
});

test('vault shape: hex fields + kdf/cipher labels', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  assert.equal(vault.kdf, 'scrypt');
  assert.equal(vault.cipher, 'aes-256-gcm');
  for (const field of ['salt', 'iv', 'ciphertext', 'tag']) {
    assert.match(vault[field], /^[0-9a-f]+$/, `${field} should be hex`);
  }
  // salt 16 bytes, iv 12 bytes, tag 16 bytes → fixed hex lengths.
  assert.equal(vault.salt.length, 32);
  assert.equal(vault.iv.length, 24);
  assert.equal(vault.tag.length, 32);
});

test('each encryption uses a fresh salt and iv', async () => {
  const a = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  const b = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('wrong password throws (auth tag mismatch)', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  await assert.rejects(() => decrypt(vault, 'wrong password'));
});

test('tampering with ciphertext throws', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  // Flip the last hex nibble of the ciphertext.
  const last = vault.ciphertext.slice(-1);
  const flipped = last === '0' ? '1' : '0';
  const tampered = { ...vault, ciphertext: vault.ciphertext.slice(0, -1) + flipped };
  await assert.rejects(() => decrypt(tampered, TEST_PASSPHRASE));
});

test('tampering with the auth tag throws', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  const last = vault.tag.slice(-1);
  const flipped = last === '0' ? '1' : '0';
  const tampered = { ...vault, tag: vault.tag.slice(0, -1) + flipped };
  await assert.rejects(() => decrypt(tampered, TEST_PASSPHRASE));
});

test('isVault accepts a real vault and rejects junk', async () => {
  const vault = await encrypt(SAMPLE_KEY, TEST_PASSPHRASE);
  assert.equal(isVault(vault), true);

  assert.equal(isVault(null), false);
  assert.equal(isVault(undefined), false);
  assert.equal(isVault('string'), false);
  assert.equal(isVault(42), false);
  assert.equal(isVault({}), false);
  assert.equal(isVault({ salt: 'zz', iv: 'aa', ciphertext: 'bb', tag: 'cc', kdf: 'scrypt', cipher: 'aes-256-gcm' }), false); // non-hex salt
  assert.equal(isVault({ ...vault, kdf: 'pbkdf2' }), false); // wrong kdf
  assert.equal(isVault({ ...vault, cipher: 'aes-128-cbc' }), false); // wrong cipher
  const { tag, ...missingTag } = vault;
  assert.equal(isVault(missingTag), false); // missing field
});
