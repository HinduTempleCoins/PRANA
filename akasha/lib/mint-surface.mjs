/**
 * mint-surface.mjs — AK11
 *
 * A headless mint DRIVER for the Akasha wallet. Given a mint-capable contract
 * (an ERC-721/1155 collection with a `mint` / `mintEdition` / `publish` style
 * function) this module:
 *
 *   1. builds the mint calldata from the contract's ABI (via abi-form coercion),
 *   2. DRY-RUNS it with eth_call so a revert is caught BEFORE the user pays gas
 *      (the same dryRun/decodeRevert path send-flow uses for plain sends),
 *   3. estimates gas (with the txbuilder safety margin),
 *   4. resolves the PAYMENT path — native value, or an ERC-20 price that needs an
 *      allowance (approve → mint), checking allowance + balance up front,
 *   5. broadcasts the mint and DECODES the minted tokenId from the receipt's
 *      logs (matches the collection's Minted/EditionMinted/Transfer event).
 *
 * Design rules (match the rest of lib/):
 *   - loose coupling: every fn takes an ethers-style `provider` (send/request)
 *     and, where signing is needed, an injected ethers Wallet/Signer.
 *   - we REUSE txbuilder (buildTx/dryRun/sendAndWait/decodeRevert) rather than
 *     re-implementing tx/fee/revert logic, and REUSE abi-form (toInterface +
 *     coerceArgs + formModelForFunction) for ABI-driven arg coercion. This module
 *     only adds the mint-specific shape: payment resolution + tokenId decode.
 *   - fixture fallback: pass `opts.fixture` to skip the network entirely and get a
 *     deterministic result (for the read-only/offline wallet mode + tests).
 *
 * Bound mint signatures (the real PRANA NFT contracts):
 *   - RoyaltyNFT.mint(address to, string uri)                        → Transfer
 *   - MutableStatNFT.mint(address to, uint256 genome, string uri)    → Minted
 *   - EntrainmentProgramNFT.mintEdition(uint256 programId, address to) payable, native or ERC-20
 *                                                                     → EditionMinted
 *   - generic ERC-721/1155 with a single mint-like fn + a Transfer / *Minted event
 */

import { Interface, getAddress, isAddress } from 'ethers';
import { buildTx, dryRun, sendAndWait, decodeRevert } from './txbuilder.mjs';
import { toInterface, formModelForFunction, coerceArgs } from './abi-form.mjs';

// Minimal ERC-20 surface for the price/approve path.
const ERC20_IFACE = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// Standard ERC-721/1155 transfer topics — the universal "a token id moved" signal.
const TRANSFER_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
]);

// Event names (in priority order) we try to read the minted id out of. The
// contract's OWN mint event is preferred (it names the field), then the standard
// Transfer/TransferSingle, which every ERC-721/1155 emits on mint.
const MINT_EVENT_CANDIDATES = ['Minted', 'EditionMinted', 'TokenMinted', 'Mint'];

// Function names we recognize as "mint-like", in priority order.
const MINT_FN_CANDIDATES = ['mint', 'mintEdition', 'safeMint', 'mintTo', 'publish', 'publishProgram'];

function toBig(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

async function rpc(provider, method, params = []) {
  if (typeof provider?.send === 'function') return provider.send(method, params);
  if (typeof provider?.request === 'function') return provider.request({ method, params });
  throw new Error('mint-surface: provider must expose send() or request()');
}

// ---------------------------------------------------------------------------
// Mint-function discovery
// ---------------------------------------------------------------------------

/**
 * Pick the mint function on a contract ABI. If `fnName` is given it is used
 * verbatim; otherwise we look for the first recognized mint-like name.
 * @param {Interface|any[]|object} abiOrIface
 * @param {string} [fnName]
 * @returns {{ model: object, fragment: import('ethers').FunctionFragment }}
 */
export function resolveMintFunction(abiOrIface, fnName) {
  const iface = toInterface(abiOrIface);

  if (fnName) {
    const model = formModelForFunction(iface, fnName);
    return { model, iface };
  }

  // collect function names present
  const present = new Set();
  iface.forEachFunction((fn) => present.add(fn.name));
  for (const cand of MINT_FN_CANDIDATES) {
    if (present.has(cand)) {
      return { model: formModelForFunction(iface, cand), iface };
    }
  }
  throw new Error(
    `mint-surface: no mint-like function found (looked for ${MINT_FN_CANDIDATES.join(', ')}); pass opts.fnName`,
  );
}

// ---------------------------------------------------------------------------
// tokenId decode
// ---------------------------------------------------------------------------

/**
 * Decode the minted tokenId from a receipt's logs. Tries the contract's own mint
 * event first (named id/tokenId field), then the standard ERC-721 Transfer
 * (from == 0x0) and ERC-1155 TransferSingle.
 *
 * @param {Interface|any[]|object} abiOrIface  collection ABI (for its mint event)
 * @param {{logs: Array<{address:string,topics:string[],data:string}>}} receipt
 * @param {object} [opts]
 * @param {string} [opts.contractAddress]  restrict to logs from this address
 * @returns {bigint|null} the tokenId, or null if none found
 */
export function decodeMintedTokenId(abiOrIface, receipt, opts = {}) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const iface = toInterface(abiOrIface);
  const want = opts.contractAddress ? getAddress(opts.contractAddress) : null;

  const logs = receipt.logs.filter((l) => {
    if (!want) return true;
    try {
      return getAddress(l.address) === want;
    } catch {
      return true;
    }
  });

  // 1) the collection's own mint event (most explicit)
  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (MINT_EVENT_CANDIDATES.includes(parsed.name)) {
      const id = pickIdArg(parsed);
      if (id != null) return id;
    }
  }

  // 2) standard Transfer (ERC-721 mint: from == address(0)) / TransferSingle
  for (const log of logs) {
    let parsed;
    try {
      parsed = TRANSFER_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === 'Transfer') {
      // only treat from==0 as a mint
      const from = parsed.args[0];
      if (from && /^0x0+$/i.test(from)) return toBig(parsed.args[2]);
      // otherwise still return it as a best-effort id if nothing else matched
    }
    if (parsed.name === 'TransferSingle') {
      const from = parsed.args[1];
      if (from && /^0x0+$/i.test(from)) return toBig(parsed.args[3]);
    }
  }
  return null;
}

// pull the id-ish arg out of a parsed mint event (tokenId / id / first uint)
function pickIdArg(parsed) {
  const named = parsed.args;
  for (const key of ['tokenId', 'id', 'editionId']) {
    if (named[key] != null) return toBig(named[key]);
  }
  // fall back to the first uint-typed positional arg
  const inputs = parsed.fragment?.inputs ?? [];
  for (let i = 0; i < inputs.length; i++) {
    const t = inputs[i].type;
    if (typeof t === 'string' && (t.startsWith('uint') || t.startsWith('int'))) {
      return toBig(named[i]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment resolution (native or ERC-20 approve+mint)
// ---------------------------------------------------------------------------

/**
 * Resolve the payment for a mint. For a native price the value is attached to the
 * mint tx. For an ERC-20 price we check the spender allowance + payer balance and
 * report whether an approve() is required first.
 *
 * @param {object} provider
 * @param {object} payment
 * @param {string} [payment.payToken]  ERC-20 token address; falsy/zero => native
 * @param {bigint} payment.price       price in token's smallest unit (or wei if native)
 * @param {string} payment.from        the payer / minter
 * @param {string} payment.spender     the contract that pulls the ERC-20 (the collection)
 * @returns {Promise<{native:boolean, value:bigint, needsApproval:boolean, allowance?:bigint, balance?:bigint, approveTxData?:string, token?:string}>}
 */
export async function resolvePayment(provider, { payToken, price, from, spender }) {
  const value = toBig(price);
  const isNative = !payToken || /^0x0+$/i.test(payToken);

  if (isNative) {
    return { native: true, value, needsApproval: false };
  }

  const token = getAddress(payToken);
  const owner = getAddress(from);
  const spend = getAddress(spender);

  // allowance + balance reads via eth_call
  const allowance = await erc20Read(provider, token, 'allowance', [owner, spend]);
  const balance = await erc20Read(provider, token, 'balanceOf', [owner]);

  const needsApproval = allowance < value;
  const out = {
    native: false,
    value: 0n, // ERC-20 mint sends no native value
    needsApproval,
    allowance,
    balance,
    token,
  };
  if (needsApproval) {
    // exact-amount approval (callers may choose to approve max instead)
    out.approveTxData = ERC20_IFACE.encodeFunctionData('approve', [spend, value]);
    out.approveAmount = value;
  }
  return out;
}

async function erc20Read(provider, token, fn, args) {
  const data = ERC20_IFACE.encodeFunctionData(fn, args);
  const raw = await rpc(provider, 'eth_call', [{ to: token, data }, 'latest']);
  return toBig(ERC20_IFACE.decodeFunctionResult(fn, raw)[0]);
}

// ---------------------------------------------------------------------------
// prepareMint — build + dry-run + gas, no broadcast
// ---------------------------------------------------------------------------

/**
 * Prepare a mint: coerce args, build the tx, dry-run it (catch reverts), estimate
 * gas, and resolve payment (incl. ERC-20 approval need). Does NOT broadcast.
 *
 * @param {object} args
 * @param {object} args.provider                ethers-style provider
 * @param {string} args.contract                collection address
 * @param {Interface|any[]|object} args.abi     collection ABI
 * @param {string} args.from                    minter/payer
 * @param {object|any[]} args.values            raw mint args (by name or in order)
 * @param {object} [args.opts]
 * @param {string} [args.opts.fnName]           explicit mint fn name
 * @param {bigint} [args.opts.price]            price (native => attached as value; ERC-20 => allowance)
 * @param {string} [args.opts.payToken]         ERC-20 token addr (falsy => native)
 * @param {object} [args.opts.fixture]          { ok, gasEstimate, tokenId, ... } to bypass the network
 * @returns {Promise<object>} a mint plan
 */
export async function prepareMint({ provider, contract, abi, from, values, opts = {} }) {
  if (opts.fixture) return fixturePlan({ contract, abi, from, values, opts });

  if (!isAddress(contract)) throw new Error(`mint-surface: invalid contract ${contract}`);
  if (!isAddress(from)) throw new Error(`mint-surface: invalid from ${from}`);
  const to = getAddress(contract);
  const minter = getAddress(from);

  const iface = toInterface(abi);
  const { model } = resolveMintFunction(iface, opts.fnName);

  // coerce raw form values → the arg array ethers wants (reuses abi-form)
  const coerced = coerceArgs(model, values);
  const data = iface.encodeFunctionData(model.signature, coerced);

  // payment: native price rides as tx value; ERC-20 price needs allowance
  const payToken = opts.payToken;
  const price = toBig(opts.price);
  const isNative = !payToken || /^0x0+$/i.test(payToken);

  const payment = await resolvePayment(provider, {
    payToken,
    price,
    from: minter,
    spender: to,
  });
  const value = isNative ? price : 0n;

  // build the full tx (nonce/fees/gas) then dry-run it for a revert + gas
  const tx = await buildTx({ from: minter, to, value, data }, provider, {
    chainId: opts.chainId,
    gasLimit: opts.gasLimit,
  });
  const sim = await dryRun(tx, provider);

  const plan = {
    fn: model.name,
    signature: model.signature,
    contract: to,
    from: minter,
    value,
    data,
    tx,
    payment,
    ok: sim.ok,
    gasEstimate: sim.gasEstimate != null ? toBig(sim.gasEstimate) : tx.gasLimit,
    payable: model.payable,
    inputs: model.inputs,
  };
  if (!sim.ok) {
    plan.revertReason =
      sim.revertReason ?? decodeRevert(sim.returnData) ?? sim.error ?? 'execution would revert';
  }
  // surface an ERC-20 affordability warning early (dry-run can't know intent)
  if (!payment.native && payment.balance != null && payment.balance < price) {
    plan.warning = `insufficient ${payment.token} balance for price`;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// approveIfNeeded — broadcast the ERC-20 approval for an ERC-20-priced mint
// ---------------------------------------------------------------------------

/**
 * If the prepared plan reports `payment.needsApproval`, broadcast the approve()
 * tx and wait for it. No-op (returns null) for native mints or when allowance is
 * already sufficient.
 */
export async function approveIfNeeded(signer, provider, plan, opts = {}) {
  if (!plan?.payment || plan.payment.native || !plan.payment.needsApproval) return null;
  const from = plan.from;
  const tx = await buildTx(
    { from, to: plan.payment.token, value: 0n, data: plan.payment.approveTxData },
    provider,
    { chainId: opts.chainId },
  );
  return sendAndWait(signer, tx, provider, {
    confirmations: opts.confirmations ?? 1,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// executeMint — broadcast the mint and decode the tokenId
// ---------------------------------------------------------------------------

/**
 * Broadcast a prepared mint plan and decode the minted tokenId from the receipt.
 * Refuses to send a plan that dry-ran to a revert (`plan.ok === false`).
 *
 * @returns {Promise<{hash:string, receipt:object|null, tokenId:bigint|null}>}
 */
export async function executeMint({ signer, provider, abi, plan, opts = {} }) {
  if (!plan) throw new Error('mint-surface: a prepared plan is required');
  if (plan.ok === false && !opts.force) {
    throw new Error(`mint-surface: refusing to send a reverting mint: ${plan.revertReason}`);
  }
  if (!signer || typeof signer.signTransaction !== 'function') {
    throw new Error('mint-surface: an ethers Wallet/Signer is required to mint');
  }

  const result = await sendAndWait(signer, plan.tx, provider, {
    confirmations: opts.confirmations ?? 1,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  });

  // mined-but-reverted
  if (result.receipt && result.receipt.status != null && toBig(result.receipt.status) === 0n) {
    const e = new Error(`mint-surface: mint reverted on-chain (hash ${result.hash})`);
    e.code = 'REVERTED';
    e.hash = result.hash;
    throw e;
  }

  const tokenId = decodeMintedTokenId(abi ?? plan.abi, result.receipt, {
    contractAddress: plan.contract,
  });
  return { ...result, tokenId };
}

// ---------------------------------------------------------------------------
// fixture fallback (offline / read-only wallet mode + deterministic tests)
// ---------------------------------------------------------------------------

function fixturePlan({ contract, abi, from, values, opts }) {
  const fx = opts.fixture;
  const iface = toInterface(abi);
  const { model } = resolveMintFunction(iface, opts.fnName);
  const coerced = coerceArgs(model, values);
  const data = iface.encodeFunctionData(model.signature, coerced);
  const price = toBig(opts.price);
  const isNative = !opts.payToken || /^0x0+$/i.test(opts.payToken);
  return {
    fixture: true,
    fn: model.name,
    signature: model.signature,
    contract: isAddress(contract) ? getAddress(contract) : contract,
    from,
    value: isNative ? price : 0n,
    data,
    tx: fx.tx ?? null,
    payment: fx.payment ?? { native: isNative, value: isNative ? price : 0n, needsApproval: false },
    ok: fx.ok !== false,
    revertReason: fx.ok === false ? (fx.revertReason ?? 'fixture revert') : undefined,
    gasEstimate: toBig(fx.gasEstimate ?? 120000),
    tokenId: fx.tokenId != null ? toBig(fx.tokenId) : null,
    payable: model.payable,
    inputs: model.inputs,
  };
}

export default {
  resolveMintFunction,
  decodeMintedTokenId,
  resolvePayment,
  prepareMint,
  approveIfNeeded,
  executeMint,
  MINT_FN_CANDIDATES,
  MINT_EVENT_CANDIDATES,
};
