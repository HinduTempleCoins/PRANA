// txbuilder.mjs — transaction builder + signer + dry-run for Akasha.
//
// Loose coupling: every function takes an ethers-style `provider` (must expose
// async `send(method, params)` — ethers v6 JsonRpcProvider does) and, where
// signing is needed, an ethers `Wallet`/`Signer` injected by the caller. We
// never touch the keyvault directly.
//
// Fee strategy: PRANA is a post-London core-geth fork, so blocks carry
// `baseFeePerGas` and the chain supports EIP-1559 (type-2) txs. We DETECT this
// from the latest block: if `baseFeePerGas` is present we build a 1559 tx
// (maxFeePerGas / maxPriorityFeePerGas from eth_feeData-style data); otherwise
// we fall back to a legacy `gasPrice` tx. This keeps the builder correct even
// against a pre-London / non-1559 node or a misconfigured genesis.

import { Interface, getAddress } from 'ethers';

export const PRANA_CHAIN_ID = 108369;

// Multiply estimated gas by this safety margin (estimateGas can under-report
// for txs whose gas use depends on state the node can't fully simulate).
const GAS_LIMIT_MARGIN_NUM = 12n; // 1.2x
const GAS_LIMIT_MARGIN_DEN = 10n;

// Default priority fee when the node returns none (1 gwei).
const DEFAULT_PRIORITY_FEE = 1_000_000_000n;

const errorIface = new Interface(['function Error(string)', 'function Panic(uint256)']);
const ERROR_STRING_SELECTOR = '0x08c379a0'; // Error(string)
const PANIC_SELECTOR = '0x4e487b71'; // Panic(uint256)

// --- low-level helpers ------------------------------------------------------

function toBig(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v); // handles 0x.. and decimal
  throw new Error(`cannot coerce ${typeof v} to bigint`);
}

function hexQuantity(v) {
  return '0x' + toBig(v).toString(16);
}

async function rpc(provider, method, params = []) {
  if (typeof provider?.send === 'function') {
    return provider.send(method, params);
  }
  if (typeof provider?.request === 'function') {
    return provider.request({ method, params });
  }
  throw new Error('provider must expose send(method, params) or request({method,params})');
}

// --- fee detection ----------------------------------------------------------

/**
 * Inspect the chain and return a fee plan.
 * @returns {Promise<{ type: 1|2, maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint, gasPrice?: bigint, baseFeePerGas?: bigint }>}
 */
export async function detectFees(provider) {
  // Pull the latest block to see if the chain is post-London (has a base fee).
  const block = await rpc(provider, 'eth_getBlockByNumber', ['latest', false]);
  const baseFeePerGas = block && block.baseFeePerGas != null ? toBig(block.baseFeePerGas) : null;

  if (baseFeePerGas != null) {
    // EIP-1559 path. Prefer the node's suggestion if it offers one.
    let priority = DEFAULT_PRIORITY_FEE;
    try {
      const suggested = await rpc(provider, 'eth_maxPriorityFeePerGas', []);
      if (suggested != null) priority = toBig(suggested);
    } catch {
      // Not all nodes implement eth_maxPriorityFeePerGas; keep the default.
    }
    // maxFee = 2*baseFee + priority — generous headroom for a couple of blocks
    // of base-fee growth (matches common wallet heuristics).
    const maxFeePerGas = baseFeePerGas * 2n + priority;
    return {
      type: 2,
      baseFeePerGas,
      maxPriorityFeePerGas: priority,
      maxFeePerGas,
    };
  }

  // Legacy path — no base fee, use eth_gasPrice.
  const gasPrice = toBig(await rpc(provider, 'eth_gasPrice', []));
  return { type: 1, gasPrice };
}

// --- buildTx ----------------------------------------------------------------

/**
 * Build a fully-populated transaction request: nonce, gasLimit (with margin),
 * fee fields (1559 or legacy), chainId. Returns a plain object with bigint
 * numeric fields, ready for an ethers Wallet to sign.
 *
 * @param {{to?:string, value?:bigint|string|number, data?:string, from:string}} req
 * @param {object} provider  ethers-style provider (send/request)
 * @param {{chainId?:number, gasLimit?:bigint}} [opts]
 */
export async function buildTx(req, provider, opts = {}) {
  if (!req || typeof req !== 'object') throw new Error('buildTx: req object required');
  const from = req.from ? getAddress(req.from) : undefined;
  if (!from) throw new Error('buildTx: req.from is required');
  const to = req.to == null ? null : getAddress(req.to);
  const value = req.value == null ? 0n : toBig(req.value);
  const data = req.data ?? '0x';
  const chainId = opts.chainId ?? PRANA_CHAIN_ID;

  // nonce (pending so queued txs don't collide)
  const nonce = Number(toBig(await rpc(provider, 'eth_getTransactionCount', [from, 'pending'])));

  // gas limit: explicit override, else estimate + margin
  let gasLimit = opts.gasLimit != null ? toBig(opts.gasLimit) : null;
  if (gasLimit == null) {
    const callObj = { from, value: hexQuantity(value), data };
    if (to != null) callObj.to = to;
    const estimated = toBig(await rpc(provider, 'eth_estimateGas', [callObj]));
    gasLimit = (estimated * GAS_LIMIT_MARGIN_NUM) / GAS_LIMIT_MARGIN_DEN;
  }

  const fees = await detectFees(provider);

  const tx = {
    from,
    to,
    value,
    data,
    nonce,
    gasLimit,
    chainId,
  };

  if (fees.type === 2) {
    tx.type = 2;
    tx.maxFeePerGas = fees.maxFeePerGas;
    tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } else {
    tx.type = 0;
    tx.gasPrice = fees.gasPrice;
  }

  return tx;
}

// --- signTx -----------------------------------------------------------------

/**
 * Sign a built tx with an injected ethers Wallet/Signer. ethers ignores `from`
 * in the tx object (the wallet's own address is authoritative), so we strip it
 * to avoid a from/address mismatch error.
 * @returns {Promise<string>} raw signed tx (0x...)
 */
export async function signTx(wallet, tx) {
  if (!wallet || typeof wallet.signTransaction !== 'function') {
    throw new Error('signTx: an ethers Wallet/Signer is required');
  }
  const { from, ...rest } = tx;
  return wallet.signTransaction(rest);
}

// --- sendAndWait ------------------------------------------------------------

/**
 * Sign, broadcast, and (optionally) wait for confirmations.
 * @param {object} wallet   ethers Wallet/Signer
 * @param {object} tx       built tx (from buildTx)
 * @param {object} provider ethers-style provider
 * @param {{confirmations?:number, pollMs?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{hash:string, receipt:object|null}>}
 */
export async function sendAndWait(wallet, tx, provider, opts = {}) {
  const confirmations = opts.confirmations ?? 1;
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const raw = await signTx(wallet, tx);
  const hash = await rpc(provider, 'eth_sendRawTransaction', [raw]);

  if (confirmations <= 0) return { hash, receipt: null };

  const start = Date.now();
  for (;;) {
    const receipt = await rpc(provider, 'eth_getTransactionReceipt', [hash]);
    if (receipt && receipt.blockNumber != null) {
      const txBlock = toBig(receipt.blockNumber);
      const head = toBig(await rpc(provider, 'eth_blockNumber', []));
      // confirmations = head - txBlock + 1
      if (head - txBlock + 1n >= BigInt(confirmations)) {
        return { hash, receipt };
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sendAndWait: timed out waiting for ${confirmations} confirmation(s) of ${hash}`);
    }
    await sleep(pollMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- revert decoding --------------------------------------------------------

/**
 * Decode standard revert payloads.
 *   Error(string)  → the revert string
 *   Panic(uint256) → "Panic(0xNN)"
 * Returns null if the data is empty or not a recognized shape.
 */
export function decodeRevert(data) {
  if (!data || typeof data !== 'string' || data === '0x') return null;
  const lower = data.toLowerCase();
  try {
    if (lower.startsWith(ERROR_STRING_SELECTOR)) {
      const [reason] = errorIface.decodeFunctionData('Error', data);
      return reason;
    }
    if (lower.startsWith(PANIC_SELECTOR)) {
      const [code] = errorIface.decodeFunctionData('Panic', data);
      return `Panic(0x${code.toString(16)})`;
    }
  } catch {
    // fall through to raw
  }
  return null;
}

// --- dryRun -----------------------------------------------------------------

/**
 * Simulate a tx without broadcasting: eth_call (to surface reverts/return data)
 * plus eth_estimateGas (so the UI can show cost). Decodes Error(string) reverts.
 *
 * @returns {Promise<{ok:boolean, returnData?:string, revertReason?:string, gasEstimate?:bigint, error?:string}>}
 */
export async function dryRun(tx, provider) {
  const callObj = {};
  if (tx.from) callObj.from = getAddress(tx.from);
  if (tx.to != null) callObj.to = getAddress(tx.to);
  callObj.value = hexQuantity(tx.value ?? 0n);
  callObj.data = tx.data ?? tx.input ?? '0x';

  let returnData;
  try {
    returnData = await rpc(provider, 'eth_call', [callObj, 'latest']);
  } catch (err) {
    // Node may surface revert data inside the error (geth: err.data is the
    // 0x... revert payload). Decode it if present.
    const revertData = extractRevertData(err);
    const reason = decodeRevert(revertData);
    return {
      ok: false,
      revertReason: reason ?? undefined,
      returnData: revertData ?? undefined,
      error: err?.message ?? String(err),
    };
  }

  // Some nodes return revert data from eth_call WITHOUT throwing. If the
  // returned data is an Error(string) payload, treat it as a revert.
  const inlineReason = decodeRevert(returnData);
  if (inlineReason != null) {
    return { ok: false, revertReason: inlineReason, returnData };
  }

  // Call succeeded — also produce a gas estimate.
  let gasEstimate;
  try {
    gasEstimate = toBig(await rpc(provider, 'eth_estimateGas', [callObj]));
  } catch (err) {
    const revertData = extractRevertData(err);
    const reason = decodeRevert(revertData);
    // estimateGas reverted even though call didn't — report it.
    return {
      ok: false,
      returnData,
      revertReason: reason ?? undefined,
      error: err?.message ?? String(err),
    };
  }

  return { ok: true, returnData, gasEstimate };
}

// geth/ethers stash revert data on various fields; check the common ones.
function extractRevertData(err) {
  if (!err) return null;
  if (typeof err.data === 'string') return err.data;
  if (err.data && typeof err.data.data === 'string') return err.data.data;
  if (err.error && typeof err.error.data === 'string') return err.error.data;
  if (err.info?.error && typeof err.info.error.data === 'string') return err.info.error.data;
  return null;
}

export default { buildTx, signTx, sendAndWait, dryRun, detectFees, decodeRevert };
