/**
 * bridge-initiate.mjs — AK19 + AK20
 *
 * In-wallet bridge INITIATION. Akasha signs exactly one transaction on the chain it
 * controls (the source chain) and then WATCHES the destination for the completion event.
 * It never finalizes the other side: collecting K-of-N validator signatures and submitting
 * the destination mint()/attestDeposit() is the off-chain relayer/attester federation's job.
 *
 * Two routes (spec: design/akasha/bridge-initiate-spec.md):
 *
 *   Route 'evm'      → CanonicalLockMintBridge (EVM ↔ EVM)
 *     withdraw: burn(uint256 amount, uint256 dstChainId, bytes32 dstAddr) → Withdrawal(...)
 *     deposit : (source chain's own burn) → PRANA-side Minted(...)  [watch only]
 *
 *   Route 'graphene' → GrapheneDepositBridge (EVM ↔ Graphene/MELEK/Hive-Engine)
 *     withdraw: withdraw(bytes32 tokenId, uint256 amount, bytes32 destinationRef)
 *               → GrapheneWithdrawal(...)
 *     deposit : NO EVM tx — native send on the Graphene chain; watch PRANA DepositMinted(...)
 *
 * Both withdraw paths burn/transfer a wrapped ERC-20, so an approve(bridge, amount) is
 * surfaced as a separate first signature.
 *
 * ethers v6. Fixture fallback: with no provider/signer the builders still produce the encoded
 * calldata + tracking handle (status 'built') so the UI and tests work with no live node.
 */

import {
  Interface,
  getAddress,
  isAddress,
  isHexString,
  zeroPadValue,
} from 'ethers';

// --- REAL bridge ABIs (bound from contracts/contracts/bridge/) ----------------------------

/** CanonicalLockMintBridge.sol — the functions/events the wallet touches or watches. */
export const CANONICAL_BRIDGE_ABI = [
  // outbound (PRANA → other EVM): the wallet signs this
  'function burn(uint256 amount, uint256 dstChainId, bytes32 dstAddr) returns (uint256 nonce)',
  'event Withdrawal(uint256 indexed withdrawalNonce, address indexed from, uint256 indexed dstChainId, bytes32 dstAddr, uint256 amount)',
  // inbound completion (relayer-submitted; the wallet only WATCHES Minted)
  'function mint(address to, uint256 amount, uint256 srcChainId, uint256 nonce, bytes[] sigs)',
  'event Minted(address indexed to, uint256 amount, uint256 indexed srcChainId, uint256 indexed nonce)',
];

/** GrapheneDepositBridge.sol — the functions/events the wallet touches or watches. */
export const GRAPHENE_BRIDGE_ABI = [
  // outbound (PRANA → Graphene): the wallet signs this
  'function withdraw(bytes32 tokenId, uint256 amount, bytes32 destinationRef) returns (uint256 nonce)',
  'event GrapheneWithdrawal(uint256 indexed nonce, bytes32 indexed tokenId, address indexed from, address wrapped, uint256 amount, bytes32 destinationRef)',
  // inbound completion (attester-submitted; the wallet only WATCHES DepositMinted)
  'function attestDeposit(bytes32 depositRef, bytes32 tokenId, address recipient, uint256 amount)',
  'event DepositMinted(bytes32 indexed depositRef, bytes32 indexed tokenId, address indexed recipient, address wrapped, uint256 amount)',
];

/** Minimal ERC-20 approve surface (both withdraw paths pull the wrapped token in). */
export const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

export const canonicalIface = new Interface(CANONICAL_BRIDGE_ABI);
export const grapheneIface = new Interface(GRAPHENE_BRIDGE_ABI);
export const erc20Iface = new Interface(ERC20_APPROVE_ABI);

export const ROUTES = Object.freeze({ EVM: 'evm', GRAPHENE: 'graphene' });
export const DIRECTIONS = Object.freeze({ DEPOSIT: 'deposit', WITHDRAW: 'withdraw' });
export const STATUS = Object.freeze({
  BUILT: 'built',
  INITIATED: 'initiated',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  TIMEOUT: 'timeout',
  FAILED: 'failed',
});

// --- helpers ------------------------------------------------------------------------------

function toBig(v) {
  if (v == null) throw new Error('amount is required');
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

/** Encode an EVM recipient (20-byte address) into the bytes32 `dstAddr` the bridge stores. */
export function encodeEvmRecipient(addr) {
  if (typeof addr !== 'string' || !isAddress(addr)) {
    throw new Error(`invalid EVM recipient address: ${addr}`);
  }
  return zeroPadValue(getAddress(addr), 32);
}

/** A bytes32 tokenId / destinationRef must be exactly 32 bytes of hex. */
function requireBytes32(value, label) {
  if (typeof value !== 'string' || !isHexString(value, 32)) {
    throw new Error(`${label} must be a 32-byte hex string (bytes32)`);
  }
  return value;
}

function requireBridge(addr) {
  if (typeof addr !== 'string' || !isAddress(addr)) {
    throw new Error(`bridge address is required and must be a valid address: ${addr}`);
  }
  return getAddress(addr);
}

/**
 * Optionally submit a built request through an injected ethers signer. Returns the tx hash, or
 * null in fixture mode (no signer). Kept tiny on purpose — the source tx is the only thing the
 * wallet ever broadcasts for a bridge transfer.
 */
async function maybeSubmit(signer, request, submit) {
  if (!submit) return null;
  if (!signer || typeof signer.sendTransaction !== 'function') {
    throw new Error('submit:true requires an ethers signer with sendTransaction');
  }
  const sent = await signer.sendTransaction(request);
  return sent.hash;
}

function newHandle(fields) {
  const now = Date.now();
  return {
    route: null,
    direction: null,
    status: STATUS.BUILT,
    srcChainId: null,
    dstChainId: null,
    token: null,
    amount: null,
    recipient: null,
    approval: null,
    srcTxHash: null,
    nonce: null,
    completionEvent: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

// --- buildWithdraw ------------------------------------------------------------------------

/**
 * Build (and optionally submit) a bridge WITHDRAW from PRANA out to the destination chain.
 *
 * @param {object} p
 * @param {'evm'|'graphene'} p.route
 * @param {string}  p.bridge        bridge contract address on PRANA
 * @param {string}  p.token         EVM route: wrapped ERC-20 address. Graphene route: 32-byte tokenId.
 * @param {bigint|string|number} p.amount
 * @param {string}  p.recipient     EVM route: dst EVM address. Graphene route: 32-byte destinationRef.
 * @param {number|bigint} [p.dstChainId]   EVM route only: destination chain id.
 * @param {number|bigint} [p.srcChainId]   recorded on the handle for correlation (default: PRANA).
 * @param {object}  [deps]
 * @param {object}  [deps.signer]   ethers signer (required only when submit:true)
 * @param {boolean} [deps.submit=false]
 * @param {boolean} [deps.withApproval=true]  also emit the approve(bridge, amount) step
 */
export async function buildWithdraw(p, deps = {}) {
  const { signer, submit = false, withApproval = true } = deps;
  const route = p?.route;
  if (route !== ROUTES.EVM && route !== ROUTES.GRAPHENE) {
    throw new Error(`unknown route: ${p?.route}`);
  }
  const bridge = requireBridge(p?.bridge);
  const amount = toBig(p?.amount);
  if (amount <= 0n) throw new Error('amount must be > 0');

  // The wrapped-token address whose allowance the bridge consumes. For the EVM route the
  // token IS the wrapped ERC-20; for the graphene route the wrapped address is looked up by
  // the contract from tokenId, so the caller passes it explicitly for the approve step.
  let approveToken = null;
  let data;
  let token;
  let recipient;
  let dstChainId = null;

  if (route === ROUTES.EVM) {
    token = getAddress(
      typeof p?.token === 'string' && isAddress(p.token)
        ? p.token
        : (() => { throw new Error('EVM route: token must be the wrapped ERC-20 address'); })(),
    );
    approveToken = token;
    if (p?.dstChainId == null) throw new Error('EVM route: dstChainId is required');
    dstChainId = Number(p.dstChainId);
    const dstAddr = encodeEvmRecipient(p?.recipient);
    recipient = getAddress(p.recipient);
    data = canonicalIface.encodeFunctionData('burn', [amount, dstChainId, dstAddr]);
  } else {
    // graphene
    token = requireBytes32(p?.token, 'tokenId');
    recipient = requireBytes32(p?.recipient, 'destinationRef');
    // wrapped address for the approval is supplied separately (the bridge holds the map).
    if (withApproval) {
      if (typeof p?.wrapped !== 'string' || !isAddress(p.wrapped)) {
        throw new Error('graphene route: `wrapped` (wrapped ERC-20 address) is required for approval');
      }
      approveToken = getAddress(p.wrapped);
    }
    data = grapheneIface.encodeFunctionData('withdraw', [token, amount, recipient]);
  }

  const srcChainId = p?.srcChainId != null ? Number(p.srcChainId) : null;
  const txRequest = { to: bridge, data, value: 0n };

  // Approval step (separate signature). We build calldata; the UI/caller submits it first.
  let approval = null;
  if (withApproval && approveToken) {
    const approveData = erc20Iface.encodeFunctionData('approve', [bridge, amount]);
    approval = { needed: true, token: approveToken, to: approveToken, data: approveData, txHash: null };
  }

  const handle = newHandle({
    route,
    direction: DIRECTIONS.WITHDRAW,
    srcChainId,
    dstChainId,
    token,
    amount,
    recipient,
    approval,
  });

  // Optional submit: approve first (if present), then the withdraw/burn.
  if (submit) {
    if (approval) {
      approval.txHash = await maybeSubmit(signer, { to: approval.to, data: approval.data, value: 0n }, true);
    }
    handle.srcTxHash = await maybeSubmit(signer, txRequest, true);
    handle.status = STATUS.INITIATED;
    touch(handle);
  }

  return { handle, txRequest, approval };
}

// --- buildDeposit -------------------------------------------------------------------------

/**
 * Build (and optionally submit) a bridge DEPOSIT into PRANA from the source chain.
 *
 * EVM route: a deposit's source-chain action is a burn() on the SOURCE chain's own
 *   CanonicalLockMintBridge — i.e. structurally a withdraw FROM that chain. This helper builds
 *   that source-chain burn (so the wallet, connected to the source chain, signs one tx) and
 *   records the PRANA-side `Minted` it should watch for.
 *
 * Graphene route: there is NO EVM transaction to sign — the value moves by a native send on
 *   the Graphene chain (handled by the graphene-signer, AK1-3). This returns a watch-only
 *   handle describing the PRANA-side `DepositMinted` to wait for.
 *
 * @param {object} p
 * @param {'evm'|'graphene'} p.route
 * @param {string}  [p.bridge]      EVM route: the SOURCE-chain bridge to burn on.
 * @param {string}  [p.token]       EVM route: source wrapped ERC-20. Graphene route: 32-byte tokenId.
 * @param {bigint|string|number} p.amount
 * @param {string}  p.recipient     PRANA recipient address (credited by the mint).
 * @param {number|bigint} [p.srcChainId]  source chain id (EVM route → goes into the burn).
 * @param {number|bigint} [p.dstChainId]  PRANA chain id (the destination to watch).
 */
export async function buildDeposit(p, deps = {}) {
  const route = p?.route;
  if (route !== ROUTES.EVM && route !== ROUTES.GRAPHENE) {
    throw new Error(`unknown route: ${p?.route}`);
  }
  const amount = toBig(p?.amount);
  if (amount <= 0n) throw new Error('amount must be > 0');
  if (typeof p?.recipient !== 'string' || !isAddress(p.recipient)) {
    throw new Error('deposit recipient must be a valid PRANA address');
  }
  const recipient = getAddress(p.recipient);

  if (route === ROUTES.GRAPHENE) {
    // Watch-only: no EVM tx. The native Graphene send is out of scope here.
    const handle = newHandle({
      route,
      direction: DIRECTIONS.DEPOSIT,
      srcChainId: p?.srcChainId != null ? Number(p.srcChainId) : null,
      dstChainId: p?.dstChainId != null ? Number(p.dstChainId) : null,
      token: requireBytes32(p?.token, 'tokenId'),
      amount,
      recipient,
      // depositRef is assigned by the Graphene tx id; unknown until the native send lands.
      nonce: null,
    });
    return {
      handle,
      txRequest: null,
      approval: null,
      // Tells the UI the next action is a native Graphene send, not an EVM signature.
      nativeSend: { chain: 'graphene', tokenId: handle.token, amount, recipient },
    };
  }

  // EVM deposit == burn() on the SOURCE chain's CanonicalLockMintBridge.
  const out = await buildWithdraw(
    {
      route: ROUTES.EVM,
      bridge: p?.bridge,
      token: p?.token,
      amount,
      recipient,
      dstChainId: p?.dstChainId, // PRANA, the destination
      srcChainId: p?.srcChainId,
    },
    deps,
  );
  out.handle.direction = DIRECTIONS.DEPOSIT;
  return out;
}

// --- receipt decode (read the nonce/correlation key from the source tx logs) --------------

/**
 * Decode the bridge's outbound event from a source-tx receipt and fold the nonce into the
 * handle. Matches Withdrawal (evm) or GrapheneWithdrawal (graphene). Returns the updated handle.
 */
export function ingestReceipt(handle, receipt) {
  const iface = handle.route === ROUTES.EVM ? canonicalIface : grapheneIface;
  const wantName = handle.route === ROUTES.EVM ? 'Withdrawal' : 'GrapheneWithdrawal';
  const logs = receipt?.logs ?? [];
  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue; // not our event
    }
    if (parsed && parsed.name === wantName) {
      handle.nonce = handle.route === ROUTES.EVM ? parsed.args.withdrawalNonce : parsed.args.nonce;
      handle.srcTxHash = receipt.hash ?? receipt.transactionHash ?? handle.srcTxHash;
      handle.status = STATUS.INITIATED;
      touch(handle);
      return handle;
    }
  }
  return handle;
}

function touch(handle) {
  handle.updatedAt = Date.now();
  return handle;
}

// --- watchCompletion (STUB of the off-chain relayer-watch) --------------------------------

/**
 * Watch the DESTINATION bridge for the completion event the off-chain relayer/attester
 * federation produces. The wallet only OBSERVES — it never submits the mint/attestDeposit.
 *
 * ⚠️ STUB. The real shape:
 *   1. Build a destination filter:
 *        EVM      → dstBridge.filters.Minted(recipient, srcChainId, nonce)
 *        Graphene → dstBridge.filters.DepositMinted(null, tokenId, recipient)
 *   2. Either subscribe (provider.on(filter, cb)) or poll queryFilter over a moving block
 *      window until a log matches the correlation key, or timeoutMs elapses.
 *   3. On match  → status 'completed' + completionEvent; on timeout → status 'timeout'
 *      (re-armable — bridges can be slow; not a failure).
 *
 * With a live `dstProvider`+`dstBridgeAddress` this performs the real queryFilter poll. Without
 * one (fixture mode) it returns the handle unchanged at status 'completing'. No relayer
 * endpoint, signer, or attester key is ever held by the wallet.
 *
 * @param {object} handle           a handle from buildWithdraw/buildDeposit/ingestReceipt
 * @param {object} [opts]
 * @param {object} [opts.dstProvider]      ethers provider on the DESTINATION chain
 * @param {object} [opts.dstContract]      ethers Contract bound to the destination bridge
 * @param {number} [opts.timeoutMs=120000]
 * @param {number} [opts.pollMs=4000]
 */
export async function watchCompletion(handle, opts = {}) {
  const { dstProvider, dstContract, timeoutMs = 120000, pollMs = 4000 } = opts;
  handle.status = STATUS.COMPLETING;
  touch(handle);

  // Fixture mode: nothing to watch against — leave it 'completing' for the UI to poll later.
  if (!dstContract && !dstProvider) {
    return handle;
  }

  const iface = handle.route === ROUTES.EVM ? canonicalIface : grapheneIface;
  const eventName = handle.route === ROUTES.EVM ? 'Minted' : 'DepositMinted';
  const eventFrag = iface.getEvent(eventName);

  // Build the indexed-topic filter as the correlation key.
  let filter;
  if (handle.route === ROUTES.EVM) {
    // Minted(to indexed, amount, srcChainId indexed, nonce indexed)
    filter = dstContract?.filters?.Minted
      ? dstContract.filters.Minted(handle.recipient, handle.srcChainId ?? null, handle.nonce ?? null)
      : { topics: iface.encodeFilterTopics(eventFrag, [handle.recipient, handle.srcChainId ?? null, handle.nonce ?? null]) };
  } else {
    // DepositMinted(depositRef indexed, tokenId indexed, recipient indexed, …)
    filter = dstContract?.filters?.DepositMinted
      ? dstContract.filters.DepositMinted(handle.nonce ?? null, handle.token ?? null, handle.recipient)
      : { topics: iface.encodeFilterTopics(eventFrag, [handle.nonce ?? null, handle.token ?? null, handle.recipient]) };
  }

  const deadline = Date.now() + timeoutMs;
  // Poll loop with unref()-ed timers so we never keep the process alive.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let logs = [];
    try {
      if (dstContract && typeof dstContract.queryFilter === 'function') {
        logs = await dstContract.queryFilter(filter);
      } else if (dstProvider && typeof dstProvider.getLogs === 'function') {
        logs = await dstProvider.getLogs({ ...filter, fromBlock: opts.fromBlock ?? 0 });
      }
    } catch {
      logs = [];
    }
    if (logs && logs.length > 0) {
      const ev = logs[logs.length - 1];
      handle.completionEvent = {
        name: eventName,
        txHash: ev.transactionHash ?? ev.hash ?? null,
        blockNumber: ev.blockNumber ?? null,
      };
      handle.status = STATUS.COMPLETED;
      touch(handle);
      return handle;
    }
    if (Date.now() >= deadline) {
      handle.status = STATUS.TIMEOUT;
      touch(handle);
      return handle;
    }
    await sleepUnref(pollMs);
  }
}

/** Sleep that does NOT keep the event loop alive (unref the timer). */
function sleepUnref(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export default {
  ROUTES,
  DIRECTIONS,
  STATUS,
  CANONICAL_BRIDGE_ABI,
  GRAPHENE_BRIDGE_ABI,
  ERC20_APPROVE_ABI,
  canonicalIface,
  grapheneIface,
  erc20Iface,
  encodeEvmRecipient,
  buildWithdraw,
  buildDeposit,
  ingestReceipt,
  watchCompletion,
};
