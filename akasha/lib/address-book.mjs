/**
 * address-book.mjs — Q7
 *
 * Local, password-encrypted contacts for the Akasha wallet.
 *
 * Contacts (name → address, with optional note) are privacy-sensitive metadata,
 * so the whole book is encrypted at rest. We do NOT roll new crypto: we reuse the
 * exact primitives the keystore (keystore.mjs) is built on — ethers' **scrypt**
 * KDF (the same `scrypt`/params an ethers keystore uses) to stretch the password,
 * then authenticated **AES-GCM** for the bytes — and the same **storage interface**
 * (saveBlob/loadBlob from storage-fs.mjs) for persistence.
 *
 * ethers v6's `encryptKeystoreJson` only encrypts a fixed {address, privateKey,
 * mnemonic} shape, which can't carry an arbitrary contacts list. So instead of
 * abusing that shape, we use the underlying KDF directly: `scrypt(password, salt)`
 * → 32-byte key → AES-GCM over `JSON.stringify(contacts)`. Same KDF + cipher family
 * as the keystore, no bespoke construction, and the GCM auth tag gives us the
 * "wrong password" rejection for free.
 *
 * The on-disk/exported envelope:
 *   { version, kdf:{name:'scrypt',N,r,p}, salt, iv, ct }   (salt/iv/ct hex)
 */

import { getAddress, isAddress, scrypt, randomBytes, getBytes, hexlify } from 'ethers';
import { webcrypto } from 'node:crypto';

const SUBTLE = webcrypto.subtle;
const VERSION = 1;
// scrypt params mirror the keystore's defaults; tests may pass cheaper ones.
const DEFAULT_SCRYPT = { N: 1 << 17, r: 8, p: 1 };

function validName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('contact name must be a non-empty string');
  }
  return name.trim();
}

function validAddress(address) {
  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error(`invalid address: ${address}`);
  }
  return getAddress(address); // EIP-55 checksum
}

/**
 * Derive a 32-byte AES key from a password + salt using ethers' scrypt (the same
 * KDF the ethers keystore uses). Returns a WebCrypto CryptoKey for AES-GCM.
 */
async function deriveKey(password, salt, params) {
  const { N, r, p } = params;
  const keyBytes = getBytes(await scrypt(Buffer.from(password, 'utf8'), salt, N, r, p, 32));
  return SUBTLE.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a JS object to an envelope { version, kdf, salt, iv, ct } (all hex). */
async function encryptPayload(obj, password, params) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, params);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = new Uint8Array(await SUBTLE.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    version: VERSION,
    kdf: { name: 'scrypt', ...params },
    salt: hexlify(salt),
    iv: hexlify(iv),
    ct: hexlify(ct),
  };
}

/** Decrypt an envelope produced by encryptPayload. Throws on wrong password. */
async function decryptPayload(env, password) {
  if (!env || env.version !== VERSION) throw new Error('address-book: unsupported envelope');
  const params = { N: env.kdf.N, r: env.kdf.r, p: env.kdf.p };
  const key = await deriveKey(password, getBytes(env.salt), params);
  let pt;
  try {
    pt = await SUBTLE.decrypt({ name: 'AES-GCM', iv: getBytes(env.iv) }, key, getBytes(env.ct));
  } catch {
    // AES-GCM auth-tag failure == wrong password (or tampered data).
    throw new Error('address-book: incorrect password');
  }
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}

export class AddressBook {
  /**
   * @param {object} [opts]
   * @param {{saveBlob,loadBlob}} [opts.storage]  persistence (storage-fs.mjs)
   * @param {{N,r,p}} [opts.scrypt]               KDF params override (tests use cheap)
   */
  constructor(opts = {}) {
    this.storage = opts.storage ?? null;
    this._scrypt = opts.scrypt ?? DEFAULT_SCRYPT;
    /** @type {Map<string,{name,address,note?}>} keyed by lowercase name */
    this._contacts = new Map();
  }

  // ----- in-memory ops ------------------------------------------------------

  /** Add a contact. Throws on duplicate name or invalid address. */
  add(name, address, note) {
    const n = validName(name);
    const key = n.toLowerCase();
    if (this._contacts.has(key)) throw new Error(`duplicate contact name: ${n}`);
    const a = validAddress(address);
    const entry = { name: n, address: a };
    if (note != null) {
      if (typeof note !== 'string') throw new Error('note must be a string');
      entry.note = note;
    }
    this._contacts.set(key, entry);
    return entry;
  }

  /** Get a contact by name (case-insensitive), or undefined. */
  get(name) {
    if (typeof name !== 'string') return undefined;
    return this._contacts.get(name.trim().toLowerCase());
  }

  /** Remove a contact by name. Returns true if one was removed. */
  remove(name) {
    if (typeof name !== 'string') return false;
    return this._contacts.delete(name.trim().toLowerCase());
  }

  /** Find a contact by address (checksum-insensitive), or undefined. */
  findByAddress(address) {
    if (typeof address !== 'string') return undefined;
    const target = address.toLowerCase();
    for (const c of this._contacts.values()) {
      if (c.address.toLowerCase() === target) return c;
    }
    return undefined;
  }

  /** All contacts, sorted by name. */
  list() {
    return [...this._contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Substring search over name + note + address (case-insensitive).
   * @param {string} query
   */
  search(query) {
    if (typeof query !== 'string' || query.trim() === '') return this.list();
    const q = query.trim().toLowerCase();
    return this.list().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q) ||
        (c.note ? c.note.toLowerCase().includes(q) : false),
    );
  }

  // ----- encrypted persistence / export ------------------------------------

  /** Produce an encrypted envelope object for the current contacts. */
  async exportEncrypted(password) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('password must be a non-empty string');
    }
    return encryptPayload({ contacts: this.list() }, password, this._scrypt);
  }

  /** Replace contacts from an encrypted envelope. Throws on wrong password. */
  async importEncrypted(envelope, password) {
    const data = await decryptPayload(envelope, password);
    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    this._contacts.clear();
    for (const c of contacts) this.add(c.name, c.address, c.note);
    return this.list();
  }

  /** Encrypt + persist via the storage interface (saveBlob). */
  async save(password) {
    if (!this.storage) throw new Error('address-book: no storage configured');
    const env = await this.exportEncrypted(password);
    await this.storage.saveBlob(JSON.stringify(env));
  }

  /**
   * Load + decrypt from storage (loadBlob). No-op if nothing is stored.
   * @returns {Promise<boolean>} true if a store existed and was loaded.
   */
  async load(password) {
    if (!this.storage) throw new Error('address-book: no storage configured');
    const blob = await this.storage.loadBlob();
    if (!blob) return false;
    await this.importEncrypted(JSON.parse(blob), password);
    return true;
  }
}

export default { AddressBook };
