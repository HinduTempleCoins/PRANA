// keyvault.js — client-side key material for Akasha.
// All functions are pure and perform NO network access; key material never
// leaves the process.
import {
  generateMnemonic,
  english,
  mnemonicToAccount,
  generatePrivateKey,
  privateKeyToAccount,
} from 'viem/accounts';

// Generate a fresh 12-word BIP-39 mnemonic from the English wordlist.
export function newMnemonic() {
  return generateMnemonic(english);
}

// Derive a viem account from a mnemonic at the given address index.
export function accountFromMnemonic(mnemonic, index = 0) {
  return mnemonicToAccount(mnemonic, { addressIndex: index });
}

// Derive `count` addresses from a mnemonic, returning {index, address} pairs.
export function deriveAddresses(mnemonic, count) {
  const out = [];
  for (let index = 0; index < count; index++) {
    out.push({ index, address: accountFromMnemonic(mnemonic, index).address });
  }
  return out;
}

// Generate a fresh random private key (0x-prefixed hex).
export function newPrivateKey() {
  return generatePrivateKey();
}

// Derive a viem account from a private key.
export function accountFromPrivateKey(pk) {
  return privateKeyToAccount(pk);
}
