// explorer-links.mjs — EIP-3091 explorer link builder for Akasha.
//
// EIP-3091 standardizes block-explorer URL paths so wallets can deep-link to a
// block/tx/address/token on ANY conformant explorer just by knowing its base URL:
//   {base}/block/{number}
//   {base}/tx/{hash}
//   {base}/address/{hash}
//   {base}/token/{hash}
//
// All helpers are pure/offline and validate their inputs (tx-hash shape,
// address checksum via ethers getAddress, block-number is a non-negative int).

import { getAddress } from 'ethers';

// Strip any trailing slashes so we never emit `https://x.io//block/1`.
function normalizeBase(base) {
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('explorerLink: base URL must be a non-empty string');
  }
  // Allow http(s) and protocol-relative; reject obvious junk.
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`explorerLink: base URL must start with http(s)://, got "${base}"`);
  }
  return base.replace(/\/+$/, '');
}

// 0x + 64 hex chars.
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function validTxHash(hash) {
  if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) {
    throw new Error(`explorerLink: invalid transaction hash "${hash}"`);
  }
  return hash;
}

function validBlock(n) {
  // Accept number, bigint, or numeric/hex string; reject negatives & non-ints.
  let big;
  if (typeof n === 'bigint') {
    big = n;
  } else if (typeof n === 'number') {
    if (!Number.isInteger(n)) throw new Error(`explorerLink: block must be an integer, got ${n}`);
    big = BigInt(n);
  } else if (typeof n === 'string' && n.length > 0) {
    big = BigInt(n); // handles 0x.. and decimal; throws on garbage
  } else {
    throw new Error(`explorerLink: invalid block identifier "${n}"`);
  }
  if (big < 0n) throw new Error(`explorerLink: block number must be non-negative, got ${big}`);
  return big.toString(); // decimal form for the URL
}

function validAddress(addr) {
  // getAddress validates the hex shape AND the checksum (throws otherwise),
  // and returns the canonical EIP-55 checksummed form.
  return getAddress(addr);
}

/**
 * Build an EIP-3091 explorer link. Pass EXACTLY ONE of block|tx|address|token.
 *
 * @param {string} base  explorer base URL, e.g. 'https://explorer.prana.network'
 * @param {{block?:number|bigint|string, tx?:string, address?:string, token?:string}} target
 * @returns {string} the deep link
 */
export function explorerLink(base, target) {
  const root = normalizeBase(base);
  if (!target || typeof target !== 'object') {
    throw new Error('explorerLink: target object required ({block|tx|address|token})');
  }

  const keys = ['block', 'tx', 'address', 'token'].filter((k) => target[k] != null);
  if (keys.length !== 1) {
    throw new Error(
      `explorerLink: pass exactly one of block|tx|address|token (got ${keys.length}: [${keys.join(', ')}])`,
    );
  }
  const kind = keys[0];

  switch (kind) {
    case 'block':
      return `${root}/block/${validBlock(target.block)}`;
    case 'tx':
      return `${root}/tx/${validTxHash(target.tx)}`;
    case 'address':
      return `${root}/address/${validAddress(target.address)}`;
    case 'token':
      // EIP-3091 token path uses the contract address.
      return `${root}/token/${validAddress(target.token)}`;
    default:
      throw new Error(`explorerLink: unsupported target kind "${kind}"`);
  }
}

// Convenience single-purpose builders (thin wrappers).
export const blockLink = (base, block) => explorerLink(base, { block });
export const txLink = (base, tx) => explorerLink(base, { tx });
export const addressLink = (base, address) => explorerLink(base, { address });
export const tokenLink = (base, token) => explorerLink(base, { token });

/**
 * Build the network-metadata fragment a wallet "Add Network" form / chainlist
 * entry carries for PRANA, given an explorer URL. Mirrors the EIP-3091
 * `blockExplorerUrls` shape used by wallet_addEthereumChain.
 *
 * @param {{explorerUrl:string, chainIdHex?:string, name?:string, symbol?:string, rpcUrl?:string}} cfg
 */
export function networkFromMetadata({
  explorerUrl,
  chainIdHex = '0x1a751', // 108369
  name = 'PRANA',
  symbol = 'PRANA',
  rpcUrl = 'http://127.0.0.1:8545',
} = {}) {
  const base = normalizeBase(explorerUrl);
  return {
    chainId: chainIdHex,
    chainName: name,
    nativeCurrency: { name, symbol, decimals: 18 },
    rpcUrls: [rpcUrl],
    blockExplorerUrls: [base],
  };
}

export default {
  explorerLink,
  blockLink,
  txLink,
  addressLink,
  tokenLink,
  networkFromMetadata,
};
