/**
 * trade-market.mjs — AK13
 *
 * Headless trade driver for the Akasha wallet's open-market screen. It binds the
 * REAL on-chain {RoyaltyMarketplace} (contracts/contracts/RoyaltyMarketplace.sol):
 * a fixed-price ERC-721 marketplace settled in an ERC-20, where the NFT is escrowed
 * in the marketplace on listing.
 *
 * Bound marketplace surface (exact signatures, read off the contract):
 *   - list(IERC721 nft, uint256 tokenId, IERC20 payToken, uint256 price)
 *         returns (uint256 listingId)          ← seller must approve the NFT first
 *   - buy(uint256 listingId)                    ← buyer pays in the ERC-20 payToken
 *   - cancel(uint256 listingId)                 ← seller only ("not seller")
 *   - listings(uint256) public getter
 *         returns (address seller, address nft, uint256 tokenId,
 *                  address payToken, uint256 price, bool active)
 *   - nextListingId() public getter
 *   events: Listed(listingId, seller, nft, tokenId, payToken, price)
 *           Purchased(listingId, buyer, royaltyReceiver, royaltyAmount, sellerProceeds)
 *           Cancelled(listingId)
 *
 * APPROVE-vs-NATIVE (important): the marketplace settles in an ERC-20, NEVER in
 * native PRANA. `buy()` pulls `price` of `payToken` via SafeERC20.safeTransferFrom,
 * so the BUYER must have approved the marketplace for at least `price` of the pay
 * token first — there is NO native msg.value path. Likewise `list()` escrows the
 * NFT via transferFrom, so the SELLER must approve the NFT (per-token approve or
 * setApprovalForAll) first. This driver detects a missing allowance/approval and
 * returns the needed approve tx alongside the action tx so the UI can submit both.
 *
 * Coupling matches the rest of lib/: an ethers-style `provider` exposing
 * `send(method, params)` or `request({method,params})`. We build plain tx requests
 * ({ to, data, value, from }) and dry-run them with eth_call exactly like
 * send-flow / txbuilder. Signing/broadcast is the caller's job (keystore signer).
 *
 * Fixture fallback: with no live node, pass `opts.fixtures` (an array of listing
 * objects) to `loadListings()` and it returns them parsed/normalized without any
 * RPC — so the React view renders against fixtures offline.
 */

import { Interface, getAddress, isAddress, id as keccakId } from 'ethers';

// --- ABIs (the real signatures; nothing invented) ---------------------------

export const MARKETPLACE_ABI = [
  'function list(address nft, uint256 tokenId, address payToken, uint256 price) returns (uint256 listingId)',
  'function buy(uint256 listingId)',
  'function cancel(uint256 listingId)',
  'function nextListingId() view returns (uint256)',
  'function listings(uint256) view returns (address seller, address nft, uint256 tokenId, address payToken, uint256 price, bool active)',
  'event Listed(uint256 indexed listingId, address indexed seller, address indexed nft, uint256 tokenId, address payToken, uint256 price)',
  'event Purchased(uint256 indexed listingId, address indexed buyer, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds)',
  'event Cancelled(uint256 indexed listingId)',
];

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const ERC721_ABI = [
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

export const marketplaceIface = new Interface(MARKETPLACE_ABI);
const erc20Iface = new Interface(ERC20_ABI);
const erc721Iface = new Interface(ERC721_ABI);

const LISTED_TOPIC = keccakId('Listed(uint256,address,address,uint256,address,uint256)');
const PURCHASED_TOPIC = keccakId('Purchased(uint256,address,address,uint256,uint256)');
const CANCELLED_TOPIC = keccakId('Cancelled(uint256)');

// --- low-level helpers (same shape as send-flow / txbuilder) ----------------

async function rpc(provider, method, params = []) {
  if (typeof provider?.send === 'function') return provider.send(method, params);
  if (typeof provider?.request === 'function') return provider.request({ method, params });
  throw new Error('provider must expose send(method, params) or request({method,params})');
}

function toBig(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  return BigInt(v); // 0x.. or decimal string
}

function hexQuantity(v) {
  return '0x' + toBig(v).toString(16);
}

function requireAddress(name, v) {
  if (typeof v !== 'string' || !isAddress(v)) throw new Error(`${name}: invalid address ${v}`);
  return getAddress(v);
}

const ERROR_SELECTOR = '0x08c379a0';

/** Decode a standard Error(string) revert payload, else null. */
export function decodeMarketRevert(data) {
  if (!data || typeof data !== 'string' || data === '0x') return null;
  if (!data.toLowerCase().startsWith(ERROR_SELECTOR)) return null;
  try {
    const iface = new Interface(['function Error(string)']);
    return iface.decodeFunctionData('Error', data)[0];
  } catch {
    return null;
  }
}

function extractRevertData(err) {
  if (!err) return null;
  if (typeof err.data === 'string') return err.data;
  if (err.data && typeof err.data.data === 'string') return err.data.data;
  if (err.error && typeof err.error.data === 'string') return err.error.data;
  if (err.info?.error && typeof err.info.error.data === 'string') return err.info.error.data;
  return null;
}

/**
 * Simulate a tx with eth_call (mirrors txbuilder.dryRun). Surfaces a decoded
 * revert reason on failure so the UI can show "not seller", "inactive", etc.
 * @returns {Promise<{ok:boolean, returnData?:string, revertReason?:string, error?:string}>}
 */
export async function dryRunTx(provider, tx) {
  const callObj = { data: tx.data ?? '0x', value: hexQuantity(tx.value ?? 0n) };
  if (tx.from) callObj.from = getAddress(tx.from);
  if (tx.to != null) callObj.to = getAddress(tx.to);

  let returnData;
  try {
    returnData = await rpc(provider, 'eth_call', [callObj, 'latest']);
  } catch (err) {
    const revertData = extractRevertData(err);
    return {
      ok: false,
      revertReason: decodeMarketRevert(revertData) ?? undefined,
      returnData: revertData ?? undefined,
      error: err?.message ?? String(err),
    };
  }
  const inline = decodeMarketRevert(returnData);
  if (inline != null) return { ok: false, revertReason: inline, returnData };
  return { ok: true, returnData };
}

// --- listing normalization --------------------------------------------------

/**
 * Normalize a raw listing tuple/object into a stable shape the UI renders.
 * @returns {{listingId:string, seller:string, nft:string, tokenId:string, payToken:string, price:bigint, active:boolean}}
 */
export function normalizeListing(listingId, raw) {
  // Accept either the decoded named-tuple from `listings()` or a plain object
  // (fixtures). ethers decodes named results as an array-with-named-props.
  const seller = raw.seller ?? raw[0];
  const nft = raw.nft ?? raw[1];
  const tokenId = raw.tokenId ?? raw[2];
  const payToken = raw.payToken ?? raw[3];
  const price = raw.price ?? raw[4];
  const active = raw.active ?? raw[5];
  return {
    listingId: String(listingId),
    seller: seller ? getAddress(seller) : null,
    nft: nft ? getAddress(nft) : null,
    tokenId: toBig(tokenId).toString(),
    payToken: payToken ? getAddress(payToken) : null,
    price: toBig(price),
    active: Boolean(active),
  };
}

// --- the driver -------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.provider           ethers-style provider (send/request)
 * @param {string} deps.marketplace        deployed RoyaltyMarketplace address
 * @param {object} [deps.opts]             { account?, fixtures?, fromBlock? }
 */
export function createTradeMarket({ provider, marketplace, opts = {} } = {}) {
  if (!provider) throw new Error('trade-market: provider is required');
  const market = requireAddress('marketplace', marketplace);
  const fixtures = opts.fixtures ?? null;

  // ---- reads --------------------------------------------------------------

  /** Read the public `listings(id)` getter. */
  async function getListing(listingId) {
    const data = marketplaceIface.encodeFunctionData('listings', [toBig(listingId)]);
    const raw = await rpc(provider, 'eth_call', [{ to: market, data }, 'latest']);
    const decoded = marketplaceIface.decodeFunctionResult('listings', raw);
    return normalizeListing(listingId, decoded);
  }

  /** Read `nextListingId()` — the count of listings ever created. */
  async function nextListingId() {
    const data = marketplaceIface.encodeFunctionData('nextListingId', []);
    const raw = await rpc(provider, 'eth_call', [{ to: market, data }, 'latest']);
    return toBig(marketplaceIface.decodeFunctionResult('nextListingId', raw)[0]);
  }

  /**
   * Load listings. Strategy:
   *   - fixtures provided        → parse + return them (offline / tests).
   *   - else, with a live node   → read nextListingId() then listings(i) for each.
   *     (Robust against a chain without log indexing; for big markets the view can
   *      page. We also expose loadListingsFromLogs() for the event-driven path.)
   * @param {object} [o] { activeOnly?:boolean }
   */
  async function loadListings(o = {}) {
    const activeOnly = o.activeOnly !== false; // default: only active
    if (fixtures) {
      const out = fixtures.map((f, i) => normalizeListing(f.listingId ?? i, f));
      return activeOnly ? out.filter((l) => l.active) : out;
    }
    const n = Number(await nextListingId());
    const out = [];
    for (let i = 0; i < n; i++) {
      const l = await getListing(i);
      if (!activeOnly || l.active) out.push(l);
    }
    return out;
  }

  /**
   * Event-driven listing discovery: scan Listed logs, then drop any whose id was
   * later Purchased or Cancelled, then confirm against the on-chain `listings`
   * getter (authoritative `active` flag). Falls back to fixtures when present.
   */
  async function loadListingsFromLogs(o = {}) {
    if (fixtures) return loadListings(o);
    const fromBlock = o.fromBlock ?? opts.fromBlock ?? '0x0';
    const toBlock = o.toBlock ?? 'latest';
    const logs = await rpc(provider, 'eth_getLogs', [
      { address: market, fromBlock, toBlock, topics: [LISTED_TOPIC] },
    ]);
    const closedLogs = await rpc(provider, 'eth_getLogs', [
      { address: market, fromBlock, toBlock, topics: [[PURCHASED_TOPIC, CANCELLED_TOPIC]] },
    ]);
    const closed = new Set();
    for (const lg of closedLogs) {
      // listingId is topic[1] for both Purchased and Cancelled.
      closed.add(toBig(lg.topics[1]).toString());
    }
    const seen = new Set();
    const ids = [];
    for (const lg of logs) {
      const idStr = toBig(lg.topics[1]).toString();
      if (seen.has(idStr) || closed.has(idStr)) continue;
      seen.add(idStr);
      ids.push(idStr);
    }
    const out = [];
    for (const idStr of ids) {
      const l = await getListing(idStr);
      if (l.active) out.push(l); // authoritative recheck
    }
    return out;
  }

  // ---- ERC-20 / ERC-721 allowance reads -----------------------------------

  async function erc20Allowance(token, owner, spender) {
    const data = erc20Iface.encodeFunctionData('allowance', [
      getAddress(owner),
      getAddress(spender),
    ]);
    const raw = await rpc(provider, 'eth_call', [{ to: getAddress(token), data }, 'latest']);
    return toBig(erc20Iface.decodeFunctionResult('allowance', raw)[0]);
  }

  async function erc721Approved(nft, tokenId, owner, operator) {
    // approved if per-token getApproved == operator OR isApprovedForAll(owner, operator)
    const allData = erc721Iface.encodeFunctionData('isApprovedForAll', [
      getAddress(owner),
      getAddress(operator),
    ]);
    const allRaw = await rpc(provider, 'eth_call', [{ to: getAddress(nft), data: allData }, 'latest']);
    if (Boolean(erc721Iface.decodeFunctionResult('isApprovedForAll', allRaw)[0])) return true;
    const oneData = erc721Iface.encodeFunctionData('getApproved', [toBig(tokenId)]);
    const oneRaw = await rpc(provider, 'eth_call', [{ to: getAddress(nft), data: oneData }, 'latest']);
    return getAddress(erc721Iface.decodeFunctionResult('getApproved', oneRaw)[0]) === getAddress(operator);
  }

  // ---- tx builders --------------------------------------------------------

  function approveErc20Tx(from, token, amount) {
    return {
      kind: 'approve-erc20',
      from: getAddress(from),
      to: getAddress(token),
      data: erc20Iface.encodeFunctionData('approve', [market, toBig(amount)]),
      value: 0n,
    };
  }

  function approveErc721Tx(from, nft, tokenId) {
    return {
      kind: 'approve-erc721',
      from: getAddress(from),
      to: getAddress(nft),
      data: erc721Iface.encodeFunctionData('approve', [market, toBig(tokenId)]),
      value: 0n,
    };
  }

  /**
   * Build a LIST action. Escrows `tokenId` of `nft`, priced at `price` of `payToken`.
   * Detects whether the seller has approved the NFT to the marketplace; if not,
   * returns an `approval` tx (per-token approve) to submit first.
   *
   * @param {{nft:string, tokenId:bigint|string|number, price:bigint|string|number, payToken:string, from:string}} req
   * @returns {Promise<{action:object, approval:object|null, sim:object}>}
   */
  async function list(req) {
    const from = requireAddress('from', req.from);
    const nft = requireAddress('nft', req.nft);
    const payToken = requireAddress('payToken', req.payToken);
    const tokenId = toBig(req.tokenId);
    const price = toBig(req.price);
    if (price <= 0n) throw new Error('list: price must be > 0');

    let approval = null;
    if (!fixtures) {
      const approved = await erc721Approved(nft, tokenId, from, market).catch(() => false);
      if (!approved) approval = approveErc721Tx(from, nft, tokenId);
    }

    const action = {
      kind: 'list',
      from,
      to: market,
      data: marketplaceIface.encodeFunctionData('list', [nft, tokenId, payToken, price]),
      value: 0n,
    };

    // Dry-run the list only if no approval is pending (it would revert pre-approval).
    const sim = approval || fixtures ? { ok: true, skipped: Boolean(approval) } : await dryRunTx(provider, action);
    return { action, approval, sim };
  }

  /**
   * Build a BUY action for `listingId`. The marketplace settles in the listing's
   * ERC-20 `payToken` (NO native value), so this reads the listing, then checks
   * the buyer's ERC-20 allowance to the marketplace; if it is below `price` it
   * returns an `approval` tx (approve exactly `price`) to submit first.
   *
   * @param {bigint|string|number} listingId
   * @param {{from:string}} req
   * @returns {Promise<{action:object, approval:object|null, listing:object, sim:object}>}
   */
  async function buy(listingId, req) {
    const from = requireAddress('from', req.from);

    let listing;
    if (fixtures) {
      const f = fixtures.find((x) => String(x.listingId ?? '') === String(listingId));
      listing = f ? normalizeListing(listingId, f) : null;
    } else {
      listing = await getListing(listingId);
    }
    if (!listing || !listing.active) {
      const e = new Error(`buy: listing ${listingId} is not active`);
      e.code = 'INACTIVE';
      throw e;
    }

    let approval = null;
    if (!fixtures) {
      const allowance = await erc20Allowance(listing.payToken, from, market).catch(() => 0n);
      if (allowance < listing.price) {
        // Approve exactly the price (the buy pulls exactly `price`).
        approval = approveErc20Tx(from, listing.payToken, listing.price);
      }
    }

    const action = {
      kind: 'buy',
      from,
      to: market,
      data: marketplaceIface.encodeFunctionData('buy', [toBig(listingId)]),
      value: 0n, // ERC-20 settlement — never native
    };

    // Only dry-run when no approval is outstanding (buy reverts without allowance).
    const sim = approval || fixtures ? { ok: true, skipped: Boolean(approval) } : await dryRunTx(provider, action);
    return { action, approval, listing, sim };
  }

  /**
   * Build a CANCEL action. Only the seller may cancel; the contract reverts with
   * "not seller" otherwise — the dry-run surfaces that as `sim.revertReason`.
   *
   * @param {bigint|string|number} listingId
   * @param {{from:string}} req
   * @returns {Promise<{action:object, sim:object}>}
   */
  async function cancel(listingId, req) {
    const from = requireAddress('from', req.from);
    const action = {
      kind: 'cancel',
      from,
      to: market,
      data: marketplaceIface.encodeFunctionData('cancel', [toBig(listingId)]),
      value: 0n,
    };
    const sim = fixtures ? { ok: true } : await dryRunTx(provider, action);
    return { action, sim };
  }

  return {
    marketplace: market,
    // reads
    getListing,
    nextListingId,
    loadListings,
    loadListingsFromLogs,
    erc20Allowance,
    erc721Approved,
    // tx builders
    list,
    buy,
    cancel,
    // expose for the UI's own dry-runs of approve txs etc.
    dryRun: (tx) => dryRunTx(provider, tx),
  };
}

export default {
  createTradeMarket,
  normalizeListing,
  decodeMarketRevert,
  dryRunTx,
  marketplaceIface,
  MARKETPLACE_ABI,
};
