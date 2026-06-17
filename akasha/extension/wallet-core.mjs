// wallet-core.mjs — the ONLY place in the extension that touches keys + ethers. Imported by the popup
// (bundled by build.mjs into wallet-core.bundle.js). Wraps the existing akasha/lib keyvault so the
// extension reuses the audited vault (BIP39 + scrypt+AES, client-side) rather than reinventing it.

import { ethers } from 'ethers';
import { createVault, unlockVault, serializeVault, deriveAccount, signerFor } from '../lib/keyvault.mjs';

const RPC_URL = 'https://rpc.prana.alpha.melek.salon';
const provider = new ethers.JsonRpcProvider(RPC_URL);

/** Create a fresh vault under `password`; returns { vault, mnemonic, address, vaultFile }. */
export async function newVault(password) {
  const { vault, mnemonic } = await createVault(password);
  const acct = deriveAccount(vault, 0);
  return { vault, mnemonic, address: acct.address, vaultFile: serializeVault(vault) };
}

/** Unlock a stored (serialized) vault. Returns { vault, address }. Throws on a bad password. */
export async function openVault(vaultFile, password) {
  const vault = await unlockVault(vaultFile, password);
  return { vault, address: deriveAccount(vault, 0).address };
}

/** The checksummed address for account `index`. */
export function addressOf(vault, index = 0) { return deriveAccount(vault, index).address; }

/**
 * Sign / send a permissioned request with account `index`. Returns the EIP-1193 result:
 *   eth_sendTransaction   → tx hash (broadcast)
 *   personal_sign         → signature hex
 *   eth_signTypedData_v4  → signature hex
 */
export async function signRequest(vault, method, params, index = 0) {
  const signer = signerFor(vault, index, provider);
  if (method === 'eth_sendTransaction') {
    const tx = (params && params[0]) || {};
    const sent = await signer.sendTransaction({
      to: tx.to, value: tx.value || undefined, data: tx.data || undefined,
      gasLimit: tx.gas || tx.gasLimit || undefined,
    });
    return sent.hash;
  }
  if (method === 'personal_sign') {
    // EIP-1193: params = [messageHex, address]
    const msg = params && params[0];
    const bytes = typeof msg === 'string' && msg.startsWith('0x') ? ethers.getBytes(msg) : msg;
    return signer.signMessage(bytes);
  }
  if (method === 'eth_signTypedData_v4') {
    const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    const { domain, types, message } = td;
    const t = { ...types }; delete t.EIP712Domain;
    return signer.signTypedData(domain, t, message);
  }
  throw new Error('unsupported signing method: ' + method);
}

// Expose to the popup window (the bundle is loaded as a classic script).
if (typeof window !== 'undefined') {
  window.AkashaWalletCore = { newVault, openVault, addressOf, signRequest };
}
