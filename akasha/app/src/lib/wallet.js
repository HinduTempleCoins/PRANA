// wallet.js — the bridge between the React shell and the REAL wallet core.
//
// Per akasha/tools/.../component-architecture.md the tested, documented core is
// akasha/lib/*.mjs (ethers v6). We import those modules directly rather than
// re-implementing anything. This file:
//   * re-exports the keyvault / keystore / txbuilder / explorer-links APIs, and
//   * provides a browser localStorage implementation of the keystore's tiny
//     injectable storage interface (saveBlob / loadBlob) — the only storage
//     impl that previously existed was the Node fs one (lib/storage-fs.mjs).

export {
  createVault,
  importFromMnemonic,
  unlockVault,
  deriveAccount,
  signerFor,
  exportMnemonic,
  serializeVault,
  BIP44_ETH_BRANCH,
} from '../../../lib/keyvault.mjs';

export { Keystore } from '../../../lib/keystore.mjs';

export {
  detectFees,
  buildTx,
  signTx,
  sendAndWait,
  dryRun,
  decodeRevert,
  PRANA_CHAIN_ID,
} from '../../../lib/txbuilder.mjs';

export {
  explorerLink,
  blockLink,
  txLink,
  addressLink,
  tokenLink,
  networkFromMetadata,
} from '../../../lib/explorer-links.mjs';

// In-wallet mint surface (AK11). ethers-only modules (no node:fs) — browser-safe.
export {
  prepareMint,
  executeMint,
  approveIfNeeded,
  resolveMintFunction,
  decodeMintedTokenId,
} from '../../../lib/mint-surface.mjs';

// ABI-form helpers for rendering mint-param fields from a contract ABI.
export { formModelForFunction, toInterface } from '../../../lib/abi-form.mjs';

// Burn-to-mine driver (BC1) — the "Burn Coin Wallet" surface. ethers-only, browser-safe.
export {
  createBurnToMine,
  DEFAULT_CURRENCIES as BURN_CURRENCIES,
  NATIVE as BURN_NATIVE,
  isNative as isBurnNative,
} from '../../../lib/burn-to-mine.mjs';

// ---------------------------------------------------------------------------
// Browser localStorage storage impl (satisfies keystore's saveBlob/loadBlob).
// The blob is an already-encrypted JSON string; this layer adds NO crypto.
// ---------------------------------------------------------------------------
export function createLocalStorageStorage(key = 'akasha.keystore.v1') {
  return {
    async saveBlob(blob) {
      if (typeof blob !== 'string') throw new Error('blob must be a string');
      window.localStorage.setItem(key, blob);
    },
    async loadBlob() {
      return window.localStorage.getItem(key); // null when absent — matches interface
    },
  };
}

// ---------------------------------------------------------------------------
// Public-build helpers (mainnet).
// ---------------------------------------------------------------------------
import { Mnemonic, randomBytes, Interface, getAddress, isAddress } from 'ethers';

// Fresh 12-word BIP-39 phrase from 128 bits of CSPRNG entropy (ethers randomBytes
// = crypto.getRandomValues in the browser). Nothing is persisted here: the caller
// only stores it (encrypted) after the user has confirmed the backup.
export function newMnemonicPhrase() {
  return Mnemonic.fromEntropy(randomBytes(16)).phrase;
}

// Validates BIP-39 words + checksum; returns the normalized phrase or throws.
export function normalizeMnemonic(phrase) {
  const p = String(phrase ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return Mnemonic.fromPhrase(p).phrase;
}

// Uniform random distinct word positions for the backup quiz.
export function pickQuizPositions(wordCount, n = 3) {
  const picked = new Set();
  const buf = new Uint32Array(1);
  while (picked.size < Math.min(n, wordCount)) {
    globalThis.crypto.getRandomValues(buf);
    picked.add(buf[0] % wordCount);
  }
  return [...picked].sort((a, b) => a - b);
}

export const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export function encodeErc20Transfer(to, amount) {
  return erc20.encodeFunctionData('transfer', [getAddress(to), amount]);
}

// Decode calldata back into what will actually execute — the confirm screen shows
// THIS (decoded from the built tx), not the form inputs.
export function decodeErc20Transfer(data) {
  try {
    const [to, amount] = erc20.decodeFunctionData('transfer', data);
    return { to: getAddress(to), amount };
  } catch {
    return null;
  }
}

export { isAddress, getAddress };
