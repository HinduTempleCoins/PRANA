// akasha/lib/keystore.mjs
//
// Password-locked store that manages MULTIPLE wallet entries:
//   * "vault"    — a BIP-39/44 HD vault (see keyvault.mjs)
//   * "imported" — a single imported private key
//
// Responsibilities:
//   * addVault / addImportedKey / list / get / remove
//   * changePassword(old, new)  — re-encrypts EVERY entry under the new password
//   * lock() / unlock(password) — manages an in-memory unlocked session
//   * auto-lock after an idle timeout (clock injectable for tests)
//   * persistence via an injectable storage interface (saveBlob / loadBlob)
//
// On-disk shape (the single blob handed to storage.saveBlob):
//   {
//     version: 1,
//     entries: [
//       { id, type:"vault"|"imported", label, address|null,
//         crypto: <ethers keystore JSON string>,           // encrypted secret
//         meta: { ... } }                                  // non-secret (HD account list etc.)
//     ]
//   }
//
// Every entry's `crypto` is independently encrypted under the master password using
// the ethers keystore (scrypt + AES). There is no separate "vault key"; the password
// IS the key, applied per entry. This keeps the format simple and means a single
// leaked entry can't reveal the others' KDF state.

import {
  Wallet,
  HDNodeWallet,
  Mnemonic,
  encryptKeystoreJson,
  decryptKeystoreJson,
  getAddress,
} from "ethers";

import { BIP44_ETH_BRANCH } from "./keyvault.mjs";

const STORE_VERSION = 1;
const DEFAULT_AUTOLOCK_MS = 5 * 60 * 1000; // 5 minutes idle

// Injectable clock: defaults to real time/timers. Tests pass a fake one.
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    // Node: don't let the auto-lock timer keep the event loop (and test runners)
    // alive. Browsers return a number with no unref — guard for both runtimes.
    if (h && typeof h.unref === "function") h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h),
};

export class Keystore {
  // opts:
  //   storage   — { saveBlob, loadBlob } (required for persistence)
  //   clock     — { now, setTimeout, clearTimeout } (test injection)
  //   autoLockMs — idle timeout before auto-lock (default 5 min)
  //   scrypt    — { N,r,p } override forwarded to ethers (tests use cheap params)
  constructor(opts = {}) {
    this.storage = opts.storage ?? null;
    this.clock = opts.clock ?? realClock;
    this.autoLockMs = opts.autoLockMs ?? DEFAULT_AUTOLOCK_MS;
    this._scrypt = opts.scrypt ?? null;

    // Persisted, non-secret index of entries (crypto blobs live here too, encrypted).
    this._entries = []; // [{id,type,label,address,crypto,meta}]

    // In-memory unlocked session state.
    this._password = null;         // held only while unlocked
    this._unlocked = false;
    this._autoLockHandle = null;
  }

  // ----- persistence -------------------------------------------------------

  // Load the persisted blob (if any) into memory. Does NOT unlock.
  async load() {
    if (!this.storage) return;
    const blob = await this.storage.loadBlob();
    if (!blob) return;
    const parsed = JSON.parse(blob);
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`unsupported keystore version ${parsed.version}`);
    }
    this._entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  }

  async _persist() {
    if (!this.storage) return;
    const blob = JSON.stringify({ version: STORE_VERSION, entries: this._entries });
    await this.storage.saveBlob(blob);
  }

  // ----- session / lock ----------------------------------------------------

  get locked() {
    return !this._unlocked;
  }

  // Unlock the session by proving the password against an existing entry (or, if the
  // store is empty, simply establishing the password for future adds).
  async unlock(password) {
    requirePassword(password);
    if (this._entries.length > 0) {
      // Verify by decrypting the first entry; throws "incorrect password" on mismatch.
      await decryptKeystoreJson(this._entries[0].crypto, password);
    }
    this._password = password;
    this._unlocked = true;
    this._armAutoLock();
    return true;
  }

  // Drop all in-memory secret material. JS can't guarantee a wipe; we null references
  // (and overwrite the password string handle) so they become GC-eligible.
  lock() {
    if (this._autoLockHandle != null) {
      this.clock.clearTimeout(this._autoLockHandle);
      this._autoLockHandle = null;
    }
    this._password = null;
    this._unlocked = false;
  }

  // (Re)start the idle auto-lock timer. Called on every authenticated operation.
  _armAutoLock() {
    if (!this._unlocked) return;
    if (this._autoLockHandle != null) {
      this.clock.clearTimeout(this._autoLockHandle);
    }
    this._autoLockHandle = this.clock.setTimeout(() => {
      this.lock();
    }, this.autoLockMs);
  }

  _touch() {
    this._requireUnlocked();
    this._armAutoLock();
  }

  _requireUnlocked() {
    if (!this._unlocked || this._password == null) {
      throw new Error("keystore is locked");
    }
  }

  // ----- entries -----------------------------------------------------------

  // Add an HD vault. Accepts either a vault file object/keystore string OR a mnemonic
  // phrase via {mnemonic}. Returns the entry's id.
  // forms:
  //   addVault({ vaultFile })          — a serializeVault(...) object (already encrypted
  //                                       under THIS password)
  //   addVault({ mnemonic, label })    — encrypt a phrase under the session password
  async addVault(input) {
    this._touch();
    const id = newId();
    let crypto, address, meta;

    if (input && input.mnemonic) {
      const mnemonic = Mnemonic.fromPhrase(normalizePhrase(input.mnemonic));
      const acct0 = HDNodeWallet.fromMnemonic(mnemonic, BIP44_ETH_BRANCH).deriveChild(0);
      crypto = await this._encryptMnemonic(mnemonic);
      address = acct0.address;
      meta = { hdPath: BIP44_ETH_BRANCH, accounts: [{ index: 0, address }] };
    } else if (input && input.vaultFile) {
      const vf = input.vaultFile;
      // Verify it decrypts under the session password so we never store an entry the
      // user can't later open.
      await decryptKeystoreJson(vf.crypto, this._password);
      crypto = vf.crypto;
      address = vf.meta?.accounts?.[0]?.address ?? null;
      meta = { hdPath: vf.meta?.hdPath ?? BIP44_ETH_BRANCH, accounts: vf.meta?.accounts ?? [] };
    } else {
      throw new Error("addVault requires { mnemonic } or { vaultFile }");
    }

    this._entries.push({
      id,
      type: "vault",
      label: input.label ?? "HD Vault",
      address: address ? getAddress(address) : null,
      crypto,
      meta,
    });
    await this._persist();
    return id;
  }

  // Add a single imported private key. Returns the entry id.
  async addImportedKey(privateKey, opts = {}) {
    this._touch();
    const wallet = new Wallet(privateKey); // validates the key
    const account = { address: wallet.address, privateKey: wallet.privateKey };
    const options = this._scrypt ? { scrypt: this._scrypt } : {};
    const crypto = await encryptKeystoreJson(account, this._password, options);
    const id = newId();
    this._entries.push({
      id,
      type: "imported",
      label: opts.label ?? "Imported Key",
      address: getAddress(wallet.address),
      crypto,
      meta: {},
    });
    await this._persist();
    return id;
  }

  // Non-secret listing of entries.
  list() {
    return this._entries.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label,
      address: e.address,
    }));
  }

  // Decrypt and return usable material for one entry. Requires unlock.
  //   vault    -> { id, type, mnemonic, addresses[], signerFor(index, provider?) }
  //   imported -> { id, type, address, privateKey, signer(provider?) }
  async get(id, provider) {
    this._touch();
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no entry with id ${id}`);

    const decrypted = await decryptKeystoreJson(entry.crypto, this._password);

    if (entry.type === "vault") {
      if (!decrypted.mnemonic?.entropy) {
        throw new Error("vault entry is missing its mnemonic");
      }
      const mnemonic = Mnemonic.fromEntropy(decrypted.mnemonic.entropy);
      const root = HDNodeWallet.fromMnemonic(mnemonic, entry.meta.hdPath ?? BIP44_ETH_BRANCH);
      return {
        id: entry.id,
        type: "vault",
        label: entry.label,
        mnemonic: mnemonic.phrase, // privileged: caller asked to open the entry
        addresses: (entry.meta.accounts ?? []).map((a) => a.address),
        signerFor: (index, p) => {
          const child = root.deriveChild(index);
          return p || provider ? child.connect(p ?? provider) : child;
        },
      };
    }

    // imported single key
    const wallet = new Wallet(decrypted.privateKey);
    return {
      id: entry.id,
      type: "imported",
      label: entry.label,
      address: wallet.address,
      privateKey: wallet.privateKey,
      signer: (p) => (p || provider ? wallet.connect(p ?? provider) : wallet),
    };
  }

  // Remove an entry. Requires unlock (mutating the store is privileged).
  async remove(id) {
    this._touch();
    const before = this._entries.length;
    this._entries = this._entries.filter((e) => e.id !== id);
    if (this._entries.length === before) throw new Error(`no entry with id ${id}`);
    await this._persist();
    return true;
  }

  // Re-encrypt EVERY entry from the old password to the new one. The session must be
  // unlocked with the old password (or pass it explicitly). After success the old
  // password no longer opens any entry.
  async changePassword(oldPassword, newPassword) {
    requirePassword(oldPassword);
    requirePassword(newPassword);
    // Verify oldPassword against the session if unlocked, else just trust it for decrypt.
    if (this._unlocked && this._password != null && this._password !== oldPassword) {
      throw new Error("provided old password does not match the unlocked session");
    }

    const reEncrypted = [];
    for (const entry of this._entries) {
      // Decrypt under old password (throws "incorrect password" if wrong).
      const acct = await decryptKeystoreJson(entry.crypto, oldPassword);
      const options = this._scrypt ? { scrypt: this._scrypt } : {};

      let account;
      if (entry.type === "vault") {
        if (!acct.mnemonic?.entropy) throw new Error("vault entry lost its mnemonic");
        const mnemonic = Mnemonic.fromEntropy(acct.mnemonic.entropy);
        const acct0 = HDNodeWallet.fromMnemonic(mnemonic, entry.meta.hdPath ?? BIP44_ETH_BRANCH).deriveChild(0);
        account = {
          address: acct0.address,
          privateKey: acct0.privateKey,
          mnemonic: { entropy: mnemonic.entropy, path: entry.meta.hdPath ?? BIP44_ETH_BRANCH, locale: "en" },
        };
      } else {
        account = { address: acct.address, privateKey: acct.privateKey };
      }
      const crypto = await encryptKeystoreJson(account, newPassword, options);
      reEncrypted.push({ ...entry, crypto });
    }

    this._entries = reEncrypted;
    // Reflect the new password in the live session if we were unlocked.
    if (this._unlocked) {
      this._password = newPassword;
      this._armAutoLock();
    }
    await this._persist();
    return true;
  }

  // ----- internals ---------------------------------------------------------

  async _encryptMnemonic(mnemonic) {
    const acct0 = HDNodeWallet.fromMnemonic(mnemonic, BIP44_ETH_BRANCH).deriveChild(0);
    const account = {
      address: acct0.address,
      privateKey: acct0.privateKey,
      mnemonic: { entropy: mnemonic.entropy, path: BIP44_ETH_BRANCH, locale: "en" },
    };
    const options = this._scrypt ? { scrypt: this._scrypt } : {};
    return await encryptKeystoreJson(account, this._password, options);
  }
}

// ----- helpers -------------------------------------------------------------

function requirePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
}

function normalizePhrase(phrase) {
  if (typeof phrase !== "string") throw new Error("mnemonic phrase must be a string");
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

function newId() {
  // 16 random hex chars; no crypto-identity significance, just a handle.
  // globalThis.crypto.getRandomValues is available in Node 18+ and browsers.
  let s = "";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
