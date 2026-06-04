// akasha/lib/keyvault.mjs
//
// BIP-39 / BIP-32 / BIP-44 hierarchical-deterministic key vault for the Akasha wallet.
//
// Design notes
// ------------
// * All cryptography is delegated to ethers v6 (Mnemonic, HDNodeWallet, the JSON
//   keystore = scrypt-KDF + AES-128-CTR). We never hand-roll AES, scrypt or RNG.
// * The mnemonic phrase is the ONLY long-term secret. It is shown to the caller
//   exactly once (at creation / import) and is otherwise persisted ONLY inside the
//   ethers keystore JSON, encrypted at rest. We never keep the plaintext phrase on
//   the returned vault object.
// * An unlocked vault keeps the BIP-32 ROOT node (the m/44'/60'/0'/0 account node)
//   in memory so we can derive child accounts and produce signers without re-prompting
//   for the password. Call vault.lock() to drop that reference.
//
// Vault file format (what addVault / persistence stores):
//   {
//     version: 1,
//     crypto:  <ethers keystore JSON string>,   // encrypts entropy+privkey (mnemonic)
//     meta: { createdAt, accounts: [ { index, address } ], hdPath }
//   }

import {
  Mnemonic,
  HDNodeWallet,
  Wallet,
  randomBytes,
  encryptKeystoreJson,
  decryptKeystoreJson,
  getAddress,
} from "ethers";

// BIP-44 Ethereum account branch. Child index i appends to this -> m/44'/60'/0'/0/i.
export const BIP44_ETH_BRANCH = "m/44'/60'/0'/0";

const VAULT_VERSION = 1;

// 12 words = 128 bits = 16 bytes entropy; 24 words = 256 bits = 32 bytes.
function entropyBytesForWordCount(wordCount) {
  switch (wordCount) {
    case 12: return 16;
    case 15: return 20;
    case 18: return 24;
    case 21: return 28;
    case 24: return 32;
    default:
      throw new Error(
        `unsupported wordCount ${wordCount}; use one of 12,15,18,21,24`
      );
  }
}

// The in-memory handle the rest of the wallet uses. It deliberately does NOT hold
// the plaintext mnemonic phrase — only the derived BIP-32 branch node + the
// encrypted keystore blob (so we can re-auth for exportMnemonic without re-deriving).
class Vault {
  constructor({ rootNode, keystoreJson, meta }) {
    this._root = rootNode;        // HDNodeWallet at m/44'/60'/0'/0  (may be nulled on lock)
    this._keystoreJson = keystoreJson; // ethers keystore JSON (string), encrypted at rest
    this.meta = meta;             // { createdAt, accounts:[...], hdPath }
    this.locked = false;
  }

  get accounts() {
    return this.meta.accounts.slice();
  }

  // Drop the live BIP-32 root so derivation/signing can no longer happen without
  // a fresh unlock. JS gives us no guaranteed memory wipe, but we null the reference
  // so the node becomes eligible for GC; see README "residual memory" caveat.
  lock() {
    this._root = null;
    this.locked = true;
  }
}

// Build the persisted file object from an unlocked vault.
export function serializeVault(vault) {
  if (!vault || !vault._keystoreJson) {
    throw new Error("cannot serialize an empty/locked-without-keystore vault");
  }
  return {
    version: VAULT_VERSION,
    crypto: vault._keystoreJson,
    meta: {
      createdAt: vault.meta.createdAt,
      accounts: vault.meta.accounts.map((a) => ({ index: a.index, address: a.address })),
      hdPath: vault.meta.hdPath,
    },
  };
}

// Internal: encrypt a mnemonic into ethers keystore JSON. `scryptOverride`, when
// supplied (tests), lowers the scrypt cost so the suite stays fast.
async function encryptMnemonic(mnemonic, password, scryptOverride) {
  // ethers' keystore stores the entropy (mnemonic) under x-ethers when the account
  // carries a mnemonic descriptor. The account also needs an address+privateKey; we
  // use the index-0 account for those so the keystore is a valid standard keystore.
  const acct0 = HDNodeWallet.fromMnemonic(mnemonic, BIP44_ETH_BRANCH).deriveChild(0);
  const account = {
    address: acct0.address,
    privateKey: acct0.privateKey,
    mnemonic: {
      entropy: mnemonic.entropy,
      path: BIP44_ETH_BRANCH,
      locale: "en",
    },
  };
  const options = {};
  if (scryptOverride) options.scrypt = scryptOverride;
  return await encryptKeystoreJson(account, password, options);
}

// Internal: decrypt keystore JSON back to a Mnemonic. Throws "incorrect password"
// on a bad password (ethers' own error).
async function decryptToMnemonic(keystoreJson, password) {
  const acct = await decryptKeystoreJson(keystoreJson, password);
  if (!acct.mnemonic || !acct.mnemonic.entropy) {
    throw new Error("keystore does not contain an HD mnemonic");
  }
  return Mnemonic.fromEntropy(acct.mnemonic.entropy);
}

// Internal: build the BIP-44 branch node + initial accounts metadata for a mnemonic.
function buildFromMnemonic(mnemonic, { accountCount = 1 } = {}) {
  const root = HDNodeWallet.fromMnemonic(mnemonic, BIP44_ETH_BRANCH);
  const accounts = [];
  for (let i = 0; i < accountCount; i++) {
    const child = root.deriveChild(i);
    accounts.push({ index: i, address: child.address });
  }
  return { root, accounts };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Create a brand-new vault. Returns { vault, mnemonic }.
// `mnemonic` (the plaintext phrase) is returned ONCE for the user to back up and is
// NOT retained on the vault object. `opts.scrypt` lets tests pass {N,r,p}.
export async function createVault(password, opts = {}) {
  requirePassword(password);
  const wordCount = opts.wordCount ?? 12;
  const entropy = randomBytes(entropyBytesForWordCount(wordCount));
  const mnemonic = Mnemonic.fromEntropy(entropy);

  const keystoreJson = await encryptMnemonic(mnemonic, password, opts.scrypt);
  const { root, accounts } = buildFromMnemonic(mnemonic, {
    accountCount: opts.accountCount ?? 1,
  });

  const vault = new Vault({
    rootNode: root,
    keystoreJson,
    meta: {
      createdAt: new Date().toISOString(),
      accounts,
      hdPath: BIP44_ETH_BRANCH,
    },
  });

  return { vault, mnemonic: mnemonic.phrase };
}

// Re-create a vault from an existing mnemonic phrase. Returns { vault, mnemonic }.
export async function importFromMnemonic(phrase, password, opts = {}) {
  requirePassword(password);
  const mnemonic = Mnemonic.fromPhrase(normalizePhrase(phrase)); // validates checksum
  const keystoreJson = await encryptMnemonic(mnemonic, password, opts.scrypt);
  const { root, accounts } = buildFromMnemonic(mnemonic, {
    accountCount: opts.accountCount ?? 1,
  });
  const vault = new Vault({
    rootNode: root,
    keystoreJson,
    meta: {
      createdAt: new Date().toISOString(),
      accounts,
      hdPath: BIP44_ETH_BRANCH,
    },
  });
  return { vault, mnemonic: mnemonic.phrase };
}

// Unlock a persisted vault file (the object produced by serializeVault, or its
// `crypto` string). Returns a live, unlocked Vault. Throws on wrong password.
export async function unlockVault(vaultFileOrCrypto, password) {
  requirePassword(password);
  const file = normalizeVaultFile(vaultFileOrCrypto);
  const mnemonic = await decryptToMnemonic(file.crypto, password);
  const root = HDNodeWallet.fromMnemonic(mnemonic, file.meta?.hdPath ?? BIP44_ETH_BRANCH);

  // Trust persisted account metadata if present; otherwise derive index 0.
  let accounts = file.meta?.accounts;
  if (!accounts || accounts.length === 0) {
    accounts = [{ index: 0, address: root.deriveChild(0).address }];
  }

  return new Vault({
    rootNode: root,
    keystoreJson: file.crypto,
    meta: {
      createdAt: file.meta?.createdAt ?? new Date().toISOString(),
      accounts: accounts.map((a) => ({ index: a.index, address: getAddress(a.address) })),
      hdPath: file.meta?.hdPath ?? BIP44_ETH_BRANCH,
    },
  });
}

// Derive (or look up) account `index` on m/44'/60'/0'/0/index. Adds it to the
// vault's account list if not already present. Returns { address, path, index }.
export function deriveAccount(vault, index) {
  requireUnlocked(vault);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("account index must be a non-negative integer");
  }
  const child = vault._root.deriveChild(index);
  const path = `${vault.meta.hdPath}/${index}`;
  const existing = vault.meta.accounts.find((a) => a.index === index);
  if (!existing) {
    vault.meta.accounts.push({ index, address: child.address });
    vault.meta.accounts.sort((a, b) => a.index - b.index);
  }
  return { address: child.address, path, index };
}

// Return an ethers signer (HDNodeWallet) for account `index`, optionally connected
// to a provider. This is the ONLY way a usable private key leaves this module.
export function signerFor(vault, index, provider) {
  requireUnlocked(vault);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("account index must be a non-negative integer");
  }
  const child = vault._root.deriveChild(index);
  return provider ? child.connect(provider) : child;
}

// Re-authenticate and reveal the mnemonic phrase. Requires the password again even
// on an unlocked vault (defence-in-depth: revealing the seed is a privileged action).
export async function exportMnemonic(vault, password) {
  requirePassword(password);
  if (!vault || !vault._keystoreJson) {
    throw new Error("vault has no keystore to export from");
  }
  const mnemonic = await decryptToMnemonic(vault._keystoreJson, password);
  return mnemonic.phrase;
}

// ---------------------------------------------------------------------------
// Helpers / guards
// ---------------------------------------------------------------------------

function requirePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
}

function requireUnlocked(vault) {
  if (!vault || vault.locked || !vault._root) {
    throw new Error("vault is locked");
  }
}

function normalizePhrase(phrase) {
  if (typeof phrase !== "string") throw new Error("mnemonic phrase must be a string");
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeVaultFile(input) {
  if (typeof input === "string") {
    // A bare keystore JSON string.
    return { version: VAULT_VERSION, crypto: input, meta: {} };
  }
  if (input && typeof input === "object" && input.crypto) {
    return input;
  }
  throw new Error("invalid vault file: expected {version,crypto,meta} or keystore JSON string");
}

export { Vault };
