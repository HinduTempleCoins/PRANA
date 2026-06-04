// akasha/lib/graphene-signer.mjs
//
// Graphene (Hive / BLURT / MELEK) secp256k1 signer for the Akasha wallet (AK2).
//
// This is the Graphene-side mirror of the EVM keyvault/ethers signer. The curve is the
// same (secp256k1); only the key derivation (a master-password KDF, not BIP-32) and the
// text encodings (WIF private keys, PREFIX-base58 public keys) differ.
//
// Key derivation (verified against steemit/libcrypto-js, Hive @noisy / @bitcoinsig):
//
//     seed  = account + role + password         (utf-8 string concat, no separators)
//     priv  = sha256( seed )                     (32-byte secp256k1 scalar, used directly)
//
// Encodings:
//     WIF       = base58( 0x80 || priv(32) || sha256(sha256(...))[0:4] )
//     pubKeyStr = PREFIX + base58( pubCompressed(33) || ripemd160(pubCompressed)[0:4] )
//
// Signer boundary: the 32-byte private scalar is held ONLY inside a GrapheneSigner
// instance (a closed-over field) and never returned by a getter. The only escape is the
// explicit, intentional exportWif() — the same defence-in-depth shape as
// keyvault.exportMnemonic(). The master password is not retained on the instance.
//
// Library swappability (AK4 is gated): every curve/hash/encoding op goes through the
// `cryptoAdapter` object. The default is the in-house `nobleAdapter` built on the already-
// present @noble/secp256k1 + @noble/hashes + @scure/base. To later route through
// dhive/hive-tx, supply a matching adapter via opts.adapter — the signer logic is unchanged.
//
// See design/akasha/graphene-signer-spec.md and ./graphene-keytiers.mjs.

import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { hmac } from "@noble/hashes/hmac";
import { concatBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";

import { requireRole } from "./graphene-keytiers.mjs";

// @noble/secp256k1 v1.x needs an hmac-sha256 wired in for synchronous, RFC-6979
// deterministic signing. We use @noble/hashes' hmac so signing is sync + deterministic.
if (typeof secp.utils.hmacSha256Sync !== "function") {
  secp.utils.hmacSha256Sync = (key, ...msgs) =>
    hmac(sha256, key, concatBytes(...msgs));
}

// Default chain address prefix. Graphene chains tag public keys with a chain prefix
// (Steem/Hive historically "STM", BLURT "BLURT"); ours is "MELEK". Override per call.
export const DEFAULT_PREFIX = "MELEK";

// WIF version byte (Bitcoin mainnet 0x80 — Graphene uses the same).
const WIF_VERSION = 0x80;

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The crypto adapter (the swap seam for AK4). Default = in-house noble/scure.
// ---------------------------------------------------------------------------
export const nobleAdapter = Object.freeze({
  // KDF: (account, role, password) -> 32-byte private scalar.
  derivePriv(account, role, password) {
    const seed = enc.encode(`${account}${role}${password}`);
    const priv = sha256(seed);
    if (!secp.utils.isValidPrivateKey(priv)) {
      // Astronomically unlikely (scalar ≥ curve order or zero); surface rather than sign garbage.
      throw new Error("derived key is not a valid secp256k1 scalar; change the password");
    }
    return priv;
  },
  // 33-byte compressed public key.
  getPublicKey(priv) {
    return secp.getPublicKey(priv, true);
  },
  // Deterministic recoverable signature over a 32-byte digest.
  // Returns { sig: Uint8Array(64) compact, recovery: number }.
  signRecoverable(digest, priv) {
    const [sig, recovery] = secp.signSync(digest, priv, {
      der: false,
      recovered: true,
      canonical: true,
    });
    return { sig, recovery };
  },
  verify(sigCompact, digest, pub) {
    return secp.verify(sigCompact, digest, pub, { strict: false });
  },
  recoverPublicKey(digest, sigCompact, recovery) {
    return secp.recoverPublicKey(digest, sigCompact, recovery, true);
  },
  sha256(bytes) {
    return sha256(bytes);
  },
  ripemd160(bytes) {
    return ripemd160(bytes);
  },
  base58Encode(bytes) {
    return base58.encode(bytes);
  },
  base58Decode(str) {
    return base58.decode(str);
  },
});

// ---------------------------------------------------------------------------
// Encoding helpers (pure; operate on the adapter's primitives).
// ---------------------------------------------------------------------------

// 32-byte private scalar -> WIF string.
function privToWif(priv, adapter) {
  const payload = concatBytes(Uint8Array.of(WIF_VERSION), priv);
  const checksum = adapter.sha256(adapter.sha256(payload)).slice(0, 4);
  return adapter.base58Encode(concatBytes(payload, checksum));
}

// WIF string -> 32-byte private scalar (validates the double-sha256 checksum).
export function wifToPriv(wif, opts = {}) {
  const adapter = opts.adapter ?? nobleAdapter;
  if (typeof wif !== "string" || wif.length === 0) {
    throw new Error("WIF must be a non-empty string");
  }
  let raw;
  try {
    raw = adapter.base58Decode(wif);
  } catch {
    throw new Error("invalid WIF: not valid base58");
  }
  if (raw.length !== 37 || raw[0] !== WIF_VERSION) {
    throw new Error("invalid WIF: wrong length or version byte");
  }
  const payload = raw.slice(0, 33);
  const checksum = raw.slice(33);
  const expect = adapter.sha256(adapter.sha256(payload)).slice(0, 4);
  if (!bytesEqual(checksum, expect)) {
    throw new Error("invalid WIF: checksum mismatch");
  }
  return payload.slice(1); // drop version byte -> 32-byte scalar
}

// 33-byte compressed public key -> "PREFIX...." public-key string.
function pubToString(pub, prefix, adapter) {
  const checksum = adapter.ripemd160(pub).slice(0, 4);
  return prefix + adapter.base58Encode(concatBytes(pub, checksum));
}

// "PREFIX...." public-key string -> 33-byte compressed public key (validates ripemd160
// checksum). Returns null if it doesn't parse (callers decide whether that's an error).
export function publicKeyStringToBytes(pubKeyStr, opts = {}) {
  const adapter = opts.adapter ?? nobleAdapter;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  if (typeof pubKeyStr !== "string" || !pubKeyStr.startsWith(prefix)) return null;
  let raw;
  try {
    raw = adapter.base58Decode(pubKeyStr.slice(prefix.length));
  } catch {
    return null;
  }
  if (raw.length !== 37) return null;
  const pub = raw.slice(0, 33);
  const checksum = raw.slice(33);
  const expect = adapter.ripemd160(pub).slice(0, 4);
  return bytesEqual(checksum, expect) ? pub : null;
}

// ---------------------------------------------------------------------------
// The signer. Mirrors the ethers-signer shape (getAddress / signMessage / verify).
// ---------------------------------------------------------------------------
class GrapheneSigner {
  // Private scalar lives here in a true-private field — never returned by any getter.
  #priv;
  #adapter;

  constructor(priv, { account, role, prefix, adapter }) {
    this.#priv = priv;
    this.#adapter = adapter;
    this.account = account; // the human handle (not secret)
    this.role = role; // owner|active|posting|memo
    this.prefix = prefix;
    this._wiped = false;
  }

  #requireLive() {
    if (this._wiped || this.#priv == null) {
      throw new Error("graphene signer has been wiped");
    }
  }

  // The compressed public key bytes (33). Public material.
  publicKeyBytes() {
    this.#requireLive();
    return this.#adapter.getPublicKey(this.#priv);
  }

  // The PREFIX-base58 public-key string = this account/role's on-chain identity.
  // Mirrors ethers signer.address.
  getAddress() {
    return pubToString(this.publicKeyBytes(), this.prefix, this.#adapter);
  }

  // Alias that reads naturally on the Graphene side ("the public WIF / pubkey string").
  getPublicWif() {
    return this.getAddress();
  }

  // Sign a 32-byte digest. Graphene hashes the serialized tx to a sha256 digest and signs
  // that; tx serialization is the client lib's job (see spec §3). Returns a hex string of
  // the 65-byte canonical recoverable signature: recovery+31 byte || r(32) || s(32),
  // matching Graphene's compact-signature convention (recid + 4 + 27).
  signDigest(digest) {
    this.#requireLive();
    const d = asBytes32(digest);
    const { sig, recovery } = this.#adapter.signRecoverable(d, this.#priv);
    const header = Uint8Array.of(recovery + 31); // 31 = 27 (compact) + 4 (compressed)
    return bytesToHex(concatBytes(header, sig));
  }

  // Convenience mirror of ethers signMessage: sha256 the message first, then signDigest.
  signMessage(message) {
    const bytes = typeof message === "string" ? enc.encode(message) : asBytes(message);
    return this.signDigest(this.#adapter.sha256(bytes));
  }

  // The raw 64-byte compact signature (no recovery header) as hex — handy for libs that
  // want r||s and the recovery separately.
  signDigestCompact(digest) {
    this.#requireLive();
    const d = asBytes32(digest);
    const { sig, recovery } = this.#adapter.signRecoverable(d, this.#priv);
    return { signature: bytesToHex(sig), recovery };
  }

  // Reveal the WIF private key. Privileged, intentional escape hatch (mirrors
  // keyvault.exportMnemonic). This is the ONLY way the private scalar leaves the module.
  exportWif() {
    this.#requireLive();
    return privToWif(this.#priv, this.#adapter);
  }

  // Best-effort drop of the private scalar. JS gives no guaranteed zeroization; we null
  // the reference so it becomes GC-eligible (same caveat as keyvault.lock()).
  wipe() {
    if (this.#priv && this.#priv.fill) this.#priv.fill(0);
    this.#priv = null;
    this._wiped = true;
  }
}

// ---------------------------------------------------------------------------
// Public API — mirrors keyvault.signerFor / exportMnemonic shapes.
// ---------------------------------------------------------------------------

// Derive a signer for (account, role, password). Keys held in-module.
// opts: { prefix = DEFAULT_PREFIX, adapter = nobleAdapter }.
export function signerFor(account, role, password, opts = {}) {
  requireAccount(account);
  requireRole(role);
  requirePassword(password);
  const adapter = opts.adapter ?? nobleAdapter;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const priv = adapter.derivePriv(account, role, password);
  return new GrapheneSigner(priv, { account, role, prefix, adapter });
}

// Build a signer directly from a WIF private key (e.g. user pastes an exported key).
// `account`/`role` are metadata only here (a WIF carries no account binding).
export function signerFromWif(wif, opts = {}) {
  const adapter = opts.adapter ?? nobleAdapter;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const priv = wifToPriv(wif, { adapter });
  return new GrapheneSigner(priv, {
    account: opts.account ?? null,
    role: opts.role ?? null,
    prefix,
    adapter,
  });
}

// Re-derive and return the WIF for (account, role, password) without keeping a signer.
// Mirrors exportMnemonic (a privileged reveal). Note: there is no separate password check
// because in Graphene the password *is* the secret — deriving already requires it.
export function exportWif(account, role, password, opts = {}) {
  const signer = signerFor(account, role, password, opts);
  const wif = signer.exportWif();
  signer.wipe();
  return wif;
}

// Compute just the public-key string for (account, role, password) — no signer retained.
export function publicKeyOf(account, role, password, opts = {}) {
  const signer = signerFor(account, role, password, opts);
  const addr = signer.getAddress();
  signer.wipe();
  return addr;
}

// Verify a signature (the 65-byte recoverable hex from signDigest, or a 64-byte compact
// hex) over a 32-byte digest against an expected PREFIX-base58 public-key string.
// Mirrors ethers' verifyMessage usage shape (static, no signer needed).
export function verify(digest, signatureHex, pubKeyStr, opts = {}) {
  const adapter = opts.adapter ?? nobleAdapter;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const expectedPub = publicKeyStringToBytes(pubKeyStr, { adapter, prefix });
  if (!expectedPub) return false;

  const d = asBytes32(digest);
  let sigBytes;
  try {
    sigBytes = hexToBytes(strip0x(signatureHex));
  } catch {
    return false;
  }

  // 65 bytes = recovery header + r||s; 64 = bare compact r||s.
  if (sigBytes.length === 65) {
    const recovery = sigBytes[0] - 31;
    const compact = sigBytes.slice(1);
    if (recovery < 0 || recovery > 3) return false;
    let recovered;
    try {
      recovered = adapter.recoverPublicKey(d, compact, recovery);
    } catch {
      return false;
    }
    return bytesEqual(recovered, expectedPub) && adapter.verify(compact, d, expectedPub);
  }
  if (sigBytes.length === 64) {
    return adapter.verify(sigBytes, d, expectedPub);
  }
  return false;
}

// Like verify() but takes the raw compressed public-key bytes (skips the prefix parse).
export function verifyWithPubKey(digest, signatureHex, pubBytes, opts = {}) {
  const adapter = opts.adapter ?? nobleAdapter;
  const d = asBytes32(digest);
  let sigBytes;
  try {
    sigBytes = hexToBytes(strip0x(signatureHex));
  } catch {
    return false;
  }
  const compact = sigBytes.length === 65 ? sigBytes.slice(1) : sigBytes;
  if (compact.length !== 64) return false;
  return adapter.verify(compact, d, pubBytes);
}

// ---------------------------------------------------------------------------
// Helpers / guards
// ---------------------------------------------------------------------------

function requireAccount(account) {
  if (typeof account !== "string" || account.length === 0) {
    throw new Error("account name must be a non-empty string");
  }
}

function requirePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
}

function strip0x(s) {
  if (typeof s !== "string") throw new Error("signature must be a hex string");
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return hexToBytes(strip0x(v));
  throw new Error("expected Uint8Array or hex string");
}

function asBytes32(v) {
  const b = asBytes(v);
  if (b.length !== 32) throw new Error("digest must be exactly 32 bytes");
  return b;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export { GrapheneSigner };
