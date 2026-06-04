// keystore.js — password-encrypt secrets at rest.
//
// The "keys never leave the browser" pattern, Node-side equivalent: a secret
// (e.g. a private key) is encrypted under a password-derived key and stored as
// an opaque JSON "vault". Only the password can recover the plaintext.
//
// KDF:    scrypt (N=2^14, r=8, p=1) → 32-byte key
// Cipher: AES-256-GCM (authenticated; tampering is detected on decrypt)

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const KDF = 'scrypt';
const CIPHER = 'aes-256-gcm';
const KEY_LEN = 32; // 256-bit key for aes-256-gcm
const SALT_LEN = 16;
const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 };

function deriveKey(password, salt) {
  return scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
}

/**
 * Encrypt a plaintext string under a password.
 * @param {string} plaintext
 * @param {string} password
 * @returns {Promise<{salt:string,iv:string,ciphertext:string,tag:string,kdf:'scrypt',cipher:'aes-256-gcm'}>}
 */
export async function encrypt(plaintext, password) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('plaintext must be a string');
  }
  if (typeof password !== 'string') {
    throw new TypeError('password must be a string');
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    kdf: KDF,
    cipher: CIPHER,
  };
}

/**
 * Decrypt a vault produced by encrypt(). Throws if the password is wrong or the
 * vault was tampered with (GCM auth tag mismatch).
 * @param {object} vault
 * @param {string} password
 * @returns {Promise<string>} plaintext
 */
export async function decrypt(vault, password) {
  if (!isVault(vault)) {
    throw new TypeError('not a valid vault');
  }
  if (typeof password !== 'string') {
    throw new TypeError('password must be a string');
  }

  const salt = Buffer.from(vault.salt, 'hex');
  const iv = Buffer.from(vault.iv, 'hex');
  const ciphertext = Buffer.from(vault.ciphertext, 'hex');
  const tag = Buffer.from(vault.tag, 'hex');
  const key = deriveKey(password, salt);

  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);

  // .final() throws if the auth tag does not verify (wrong password or tampering).
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

const HEX_RE = /^[0-9a-fA-F]*$/;

function isHex(value) {
  return typeof value === 'string' && value.length > 0 && HEX_RE.test(value);
}

/**
 * Validate that an arbitrary object is a well-formed vault.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isVault(obj) {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    isHex(obj.salt) &&
    isHex(obj.iv) &&
    isHex(obj.ciphertext) &&
    isHex(obj.tag) &&
    obj.kdf === KDF &&
    obj.cipher === CIPHER
  );
}
