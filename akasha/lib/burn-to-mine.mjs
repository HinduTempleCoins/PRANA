/**
 * burn-to-mine.mjs — BC1 (Round 10, Burn-Stake doc §2): the "Burn Coin Wallet" surface.
 *
 * One-click BURN-TO-MINE from the wallet — the pool's THIRD door into PRANA mining
 * (capital / commitment, no GPU). It binds the REAL on-chain contracts:
 *
 *   - contracts/contracts/compute/MultiCurrencyBurnRouter.sol
 *   - contracts/contracts/compute/BurnStakeRegistry.sol
 *   - contracts/contracts/compute/BurnStakePriceSource.sol (Fixed/Oracle, IBurnStakePriceSource)
 *
 * ⚠⚠⚠  IRREVERSIBILITY — THE LOAD-BEARING FACT  ⚠⚠⚠
 * A burn here is a ONE-WAY DOOR. The principal you burn is DESTROYED (native PRANA is
 * sunk to the dead address 0x…dEaD; a wrapped ERC-20 is burned, reducing its totalSupply)
 * and the permanent weight credited to you in {BurnStakeRegistry} can NEVER be reduced,
 * withdrawn, transferred, or unstaked — not by you, not by an admin, not by the DAO. There
 * is deliberately no unstake function anywhere. `weightOf(account)` is monotonically
 * non-decreasing forever. You can only ever gain weight by *permanently destroying value*.
 * Surface this to the user before every burn. Do not soften it.
 *
 * Bound router surface (exact signatures, read off MultiCurrencyBurnRouter.sol):
 *   - NATIVE() view returns (address)                         // sentinel = address(0)
 *   - DEAD() view returns (address)                           // 0x…dEaD native sink
 *   - currencyAllowed(address) view returns (bool)            // wrapped-ERC20 allowlist
 *   - priceSource() view returns (address)
 *   - burnToMine(address token, uint256 amount) payable returns (uint256 weightAdded)
 *   event BurnedToMine(account, token, amount, weightAdded, bool nativeSink)
 *
 * Bound registry surface (BurnStakeRegistry.sol / IBurnStakeRegistry):
 *   - weightOf(address) view returns (uint256)                // your PERMANENT weight
 *   - totalWeight() view returns (uint256)
 *   - prana() view returns (address)                          // the native PRANA ERC20Burnable
 *   - burnPrana(uint256 amount) returns (uint256)             // simple single-currency door
 *   event Burned(account, token, amount, weightAdded)
 *
 * Bound price-source surface (IBurnStakePriceSource):
 *   - weightOf(address token, uint256 amount) view returns (uint256)   // value → PRANA-weight
 *
 * NATIVE vs ERC-20 (important — same shape as trade-market/bridge-initiate):
 *   - NATIVE PRANA (token == address(0)): burnToMine is `payable`; `amount` MUST equal msg.value.
 *     No approval. The router forwards it to the dead address. (The router credits price-source
 *     weight; the registry's own burnPrana() door is the alternative 1:1 path.)
 *   - WRAPPED ERC-20 (wMELEK / wVKBT / CURE / SMTs, per the router allowlist): the router pulls
 *     via safeTransferFrom then burns, so the caller must `approve(router, amount)` FIRST. This
 *     driver detects a short allowance and returns the needed approve tx alongside the burn tx so
 *     the UI can submit both (approve → burn), exactly like trade-market does.
 *
 * Coupling matches the rest of lib/: an ethers-style `provider` exposing send(method, params)
 * or request({method,params}); we build plain { to, data, value, from } tx requests and dry-run
 * them with eth_call (mirrors send-flow / txbuilder / trade-market). Signing/broadcast is the
 * caller's job (the keystore signer) — keys never enter this module.
 *
 * Fixture fallback: with no live node (or opts.fixtures), reads fall back to deterministic
 * fixtures and the tx builders still produce genuine calldata, so the React view and node:test
 * work fully offline.
 *
 * ethers v6.
 */

import { Interface, getAddress, isAddress, id as keccakId } from 'ethers';

// --- REAL ABIs (exact signatures; nothing invented) -------------------------

export const BURN_ROUTER_ABI = [
  'function NATIVE() view returns (address)',
  'function DEAD() view returns (address)',
  'function priceSource() view returns (address)',
  'function currencyAllowed(address token) view returns (bool)',
  'function burnToMine(address token, uint256 amount) payable returns (uint256 weightAdded)',
  'event BurnedToMine(address indexed account, address indexed token, uint256 amount, uint256 weightAdded, bool nativeSink)',
];

export const BURN_REGISTRY_ABI = [
  'function weightOf(address account) view returns (uint256)',
  'function totalWeight() view returns (uint256)',
  'function prana() view returns (address)',
  'function burnPrana(uint256 amount) returns (uint256 weightAdded)',
  'event Burned(address indexed account, address indexed token, uint256 amount, uint256 weightAdded)',
];

export const PRICE_SOURCE_ABI = [
  'function weightOf(address token, uint256 amount) view returns (uint256 weight)',
];

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

export const routerIface = new Interface(BURN_ROUTER_ABI);
export const registryIface = new Interface(BURN_REGISTRY_ABI);
export const priceSourceIface = new Interface(PRICE_SOURCE_ABI);
const erc20Iface = new Interface(ERC20_ABI);

/** The NATIVE sentinel the router uses for native PRANA (always admissible; never approved). */
export const NATIVE = '0x0000000000000000000000000000000000000000';

const BURNED_TO_MINE_TOPIC = keccakId('BurnedToMine(address,address,uint256,uint256,bool)');

// --- low-level helpers (same shape as send-flow / trade-market) -------------

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

/** Is this token the native-PRANA sentinel (address(0))? */
export function isNative(token) {
  return token == null || (typeof token === 'string' && /^0x0{40}$/i.test(token));
}

const ERROR_SELECTOR = '0x08c379a0';

/** Decode a standard Error(string) revert payload, else null. */
export function decodeBurnRevert(data) {
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
 * Simulate a tx with eth_call (mirrors txbuilder.dryRun / trade-market.dryRunTx). Surfaces a
 * decoded revert reason on failure ("CurrencyNotAllowed", "ZeroWeight", custom errors as raw
 * data, etc.) so the UI can show why a burn would fail BEFORE the irreversible broadcast.
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
      revertReason: decodeBurnRevert(revertData) ?? undefined,
      returnData: revertData ?? undefined,
      error: err?.message ?? String(err),
    };
  }
  const inline = decodeBurnRevert(returnData);
  if (inline != null) return { ok: false, revertReason: inline, returnData };
  return { ok: true, returnData };
}

// --- the default ecosystem currency catalog ---------------------------------
// PRANA is ALWAYS admissible (the NATIVE sentinel, never allowlisted on-chain). The wrapped
// ecosystem tokens are admitted by the router's on-chain allowlist (setCurrencyAllowed, a
// DAO/timelock decision). This catalog is the wallet's display list; the on-chain allowlist is
// authoritative — listCurrencies() re-checks each wrapped token via currencyAllowed() when a
// live node is present and drops any that the router has not (yet) admitted.

/** A currency entry. `address: null` means native PRANA (the NATIVE sentinel). */
export const DEFAULT_CURRENCIES = Object.freeze([
  { id: 'prana', symbol: 'PRANA', label: 'PRANA (native)', address: null, native: true },
  { id: 'wmelek', symbol: 'wMELEK', label: 'wMELEK (wrapped MELEK)', address: null, native: false },
  { id: 'wvkbt', symbol: 'wVKBT', label: 'wVKBT (wrapped VKBT)', address: null, native: false },
  { id: 'cure', symbol: 'CURE', label: 'CURE', address: null, native: false },
]);

// --- the driver -------------------------------------------------------------

/**
 * Create a burn-to-mine driver bound to a deployed router + registry.
 *
 * @param {object} deps
 * @param {object} deps.provider        ethers-style provider (send/request). May be null in fixture mode.
 * @param {string} deps.router          deployed MultiCurrencyBurnRouter address
 * @param {string} deps.registry        deployed BurnStakeRegistry address
 * @param {object} [deps.opts]
 * @param {Array}  [deps.opts.currencies]  override the display currency catalog (see DEFAULT_CURRENCIES)
 * @param {object} [deps.opts.fixtures]    offline fixtures: { allowed?:{[addr]:bool}, weights?:{[addr]:bigint},
 *                                          priceWeight?:bigint, accountWeight?:bigint, totalWeight?:bigint,
 *                                          allowance?:bigint, balance?:bigint, symbols?:{[addr]:string} }
 */
export function createBurnToMine({ provider, router, registry, opts = {} } = {}) {
  const routerAddr = requireAddress('router', router);
  const registryAddr = requireAddress('registry', registry);
  const fixtures = opts.fixtures ?? null;
  const catalog = (opts.currencies ?? DEFAULT_CURRENCIES).map((c) => ({
    ...c,
    address: c.native ? null : c.address != null ? getAddress(c.address) : null,
  }));

  function fixtureMode() {
    return !provider || !!fixtures;
  }

  // ---- reads --------------------------------------------------------------

  async function callRouter(fn, args = []) {
    const data = routerIface.encodeFunctionData(fn, args);
    const raw = await rpc(provider, 'eth_call', [{ to: routerAddr, data }, 'latest']);
    return routerIface.decodeFunctionResult(fn, raw);
  }

  async function callRegistry(fn, args = []) {
    const data = registryIface.encodeFunctionData(fn, args);
    const raw = await rpc(provider, 'eth_call', [{ to: registryAddr, data }, 'latest']);
    return registryIface.decodeFunctionResult(fn, raw);
  }

  async function callErc20(token, fn, args = []) {
    const data = erc20Iface.encodeFunctionData(fn, args);
    const raw = await rpc(provider, 'eth_call', [{ to: token, data }, 'latest']);
    return erc20Iface.decodeFunctionResult(fn, raw);
  }

  /** Is a wrapped ERC-20 admitted to burn-to-mine right now (router allowlist)? */
  async function isCurrencyAllowed(token) {
    if (isNative(token)) return true; // native PRANA is always admissible
    const addr = requireAddress('token', token);
    if (fixtureMode()) {
      const a = fixtures?.allowed;
      return a ? Boolean(a[addr] ?? a[addr.toLowerCase()]) : true;
    }
    return Boolean((await callRouter('currencyAllowed', [addr]))[0]);
  }

  /**
   * List the burn currencies available to the user: PRANA (always) plus any catalog wrapped
   * token whose on-chain `currencyAllowed` flag is true. Each entry carries an `allowed` bool
   * and a resolved `symbol` (best-effort). In fixture mode, allowlist comes from fixtures.
   */
  async function listCurrencies() {
    const out = [];
    for (const c of catalog) {
      if (c.native) {
        out.push({ ...c, allowed: true });
        continue;
      }
      if (c.address == null) {
        // Catalog entry with no resolved address (deployment not wired yet) — surfaced but
        // not selectable; the UI shows it greyed with "address not configured".
        out.push({ ...c, allowed: false, unresolved: true });
        continue;
      }
      let allowed = false;
      try {
        allowed = await isCurrencyAllowed(c.address);
      } catch {
        allowed = false;
      }
      let symbol = c.symbol;
      if (!fixtureMode()) {
        try {
          symbol = String((await callErc20(c.address, 'symbol'))[0]) || c.symbol;
        } catch {
          /* keep catalog symbol */
        }
      } else if (fixtures?.symbols?.[c.address]) {
        symbol = fixtures.symbols[c.address];
      }
      out.push({ ...c, symbol, allowed });
    }
    return out;
  }

  /**
   * Quote the PERMANENT burn-stake weight that burning `amount` (base units) of `token` would
   * credit — read from the router's configured {IBurnStakePriceSource} (weightOf). This is a
   * PURE READ: it does NOT burn anything. The returned weight is what would be permanently and
   * irrevocably credited to the burner.
   *
   * @param {string|null} token  NATIVE/null for PRANA, else the wrapped ERC-20 address.
   * @param {bigint|string|number} amount  base-unit amount to burn.
   * @returns {Promise<{weight:bigint, priceSource:string|null, token:string, amount:bigint, fixture:boolean}>}
   */
  async function quoteWeight(token, amount) {
    const amt = toBig(amount);
    if (amt <= 0n) throw new Error('amount must be > 0');
    const tokenAddr = isNative(token) ? NATIVE : requireAddress('token', token);

    if (fixtureMode()) {
      // Deterministic offline quote: per-token weight from fixtures, else 1:1 (parity).
      const w = fixtures?.weights?.[tokenAddr] ?? fixtures?.priceWeight;
      const weight = w != null ? toBig(w) : amt; // 1:1 fallback (PRANA parity)
      return { weight, priceSource: null, token: tokenAddr, amount: amt, fixture: true };
    }

    const priceSource = getAddress((await callRouter('priceSource'))[0]);
    const data = priceSourceIface.encodeFunctionData('weightOf', [tokenAddr, amt]);
    const raw = await rpc(provider, 'eth_call', [{ to: priceSource, data }, 'latest']);
    const weight = toBig(priceSourceIface.decodeFunctionResult('weightOf', raw)[0]);
    return { weight, priceSource, token: tokenAddr, amount: amt, fixture: false };
  }

  /** Read the caller's accumulated PERMANENT burn-stake weight from the registry. */
  async function accumulatedWeight(account) {
    const addr = requireAddress('account', account);
    if (fixtureMode()) {
      return {
        weight: toBig(fixtures?.accountWeight ?? 0n),
        totalWeight: toBig(fixtures?.totalWeight ?? 0n),
        fixture: true,
      };
    }
    const [weight] = await callRegistry('weightOf', [addr]);
    const [total] = await callRegistry('totalWeight');
    return { weight: toBig(weight), totalWeight: toBig(total), fixture: false };
  }

  /** Read an ERC-20 allowance of the router to spend the user's wrapped token. */
  async function allowanceOf(token, owner) {
    const tokenAddr = requireAddress('token', token);
    const ownerAddr = requireAddress('owner', owner);
    if (fixtureMode()) return toBig(fixtures?.allowance ?? 0n);
    const [a] = await callErc20(tokenAddr, 'allowance', [ownerAddr, routerAddr]);
    return toBig(a);
  }

  /** Read an ERC-20 balance (used to guard a burn against insufficient funds). */
  async function balanceOf(token, owner) {
    const tokenAddr = requireAddress('token', token);
    const ownerAddr = requireAddress('owner', owner);
    if (fixtureMode()) return toBig(fixtures?.balance ?? 0n);
    const [b] = await callErc20(tokenAddr, 'balanceOf', [ownerAddr]);
    return toBig(b);
  }

  // ---- tx builders --------------------------------------------------------

  /** Build the ERC-20 approve(router, amount) tx (the first of the two signatures). */
  function buildApprove(token, amount) {
    const tokenAddr = requireAddress('token', token);
    const data = erc20Iface.encodeFunctionData('approve', [routerAddr, toBig(amount)]);
    return { to: tokenAddr, data, value: 0n };
  }

  /**
   * Build the burn-to-mine plan: the (optional) approve tx + the burn tx, plus a dry-run of the
   * burn so the UI can confirm it WOULD succeed before the user authorizes the irreversible
   * destruction. For native PRANA the burn tx carries `value: amount` and needs no approval.
   *
   * IRREVERSIBLE: once `burnTx` is broadcast, the principal is gone and the weight is permanent.
   *
   * @param {object} p
   * @param {string} p.from            burner address (for the dry-run + approval owner check)
   * @param {string|null} p.token      NATIVE/null for PRANA, else the wrapped ERC-20 address
   * @param {bigint|string|number} p.amount  base-unit amount to burn
   * @param {object} [o]
   * @param {boolean} [o.simulate=true]  also eth_call the burn tx (skipped in fixture mode)
   * @returns {Promise<{
   *   native:boolean, token:string, amount:bigint, weight:bigint,
   *   approval:{needed:boolean, token?:string, to?:string, data?:string}|null,
   *   burnTx:{to:string,data:string,value:bigint,from:string},
   *   simulation:{ok:boolean,revertReason?:string}|null,
   *   irreversible:true, warning:string, fixture:boolean
   * }>}
   */
  async function buildBurn(p, o = {}) {
    const simulate = o.simulate !== false;
    const from = requireAddress('from', p?.from);
    const native = isNative(p?.token);
    const tokenAddr = native ? NATIVE : requireAddress('token', p?.token);
    const amount = toBig(p?.amount);
    if (amount <= 0n) throw new Error('amount must be > 0');

    // Quote the permanent weight up front so the plan always carries it (the UI shows it BIG).
    let weight = 0n;
    try {
      weight = (await quoteWeight(tokenAddr, amount)).weight;
    } catch {
      weight = 0n; // unpriced / not-yet-configured; the dry-run will also reveal ZeroWeight
    }

    // For wrapped ERC-20s the router pulls then burns → caller must approve first.
    let approval = null;
    if (!native) {
      if (!(await isCurrencyAllowed(tokenAddr))) {
        // Not admitted by the router allowlist — building a burn would only revert irreversibly
        // on submit; surface it clearly instead.
        const e = new Error(`currency not allowed for burn-to-mine: ${tokenAddr}`);
        e.code = 'CURRENCY_NOT_ALLOWED';
        throw e;
      }
      const current = await allowanceOf(tokenAddr, from).catch(() => 0n);
      if (current < amount) {
        const a = buildApprove(tokenAddr, amount);
        approval = { needed: true, token: tokenAddr, to: a.to, data: a.data };
      } else {
        approval = { needed: false, token: tokenAddr };
      }
    }

    // The burn tx itself. burnToMine(token, amount); native carries value == amount.
    const data = routerIface.encodeFunctionData('burnToMine', [tokenAddr, amount]);
    const burnTx = { to: routerAddr, data, value: native ? amount : 0n, from };

    // Dry-run the burn. NOTE: for an ERC-20 that still needs approval, the dry-run will revert at
    // safeTransferFrom — that's expected; we flag `approval.needed` so the UI knows to approve
    // first, then it can re-simulate. We only treat a non-approval revert as a hard failure.
    let simulation = null;
    if (simulate && !fixtureMode()) {
      simulation = await dryRunTx(provider, burnTx);
    }

    return {
      native,
      token: tokenAddr,
      amount,
      weight,
      approval,
      burnTx,
      simulation,
      irreversible: true,
      warning:
        'Burning is PERMANENT. The amount you burn is destroyed forever and the burn-stake ' +
        'weight you receive can never be unstaked, withdrawn, or transferred — by anyone, ever.',
      fixture: fixtureMode(),
    };
  }

  // ---- receipt decode -----------------------------------------------------

  /** Decode the BurnedToMine event from a burn-tx receipt → { account, token, amount, weightAdded, nativeSink }. */
  function decodeBurnReceipt(receipt) {
    const logs = receipt?.logs ?? [];
    for (const log of logs) {
      if (!log?.topics || log.topics[0]?.toLowerCase() !== BURNED_TO_MINE_TOPIC.toLowerCase()) continue;
      try {
        const parsed = routerIface.parseLog(log);
        if (parsed?.name === 'BurnedToMine') {
          return {
            account: parsed.args.account,
            token: parsed.args.token,
            amount: toBig(parsed.args.amount),
            weightAdded: toBig(parsed.args.weightAdded),
            nativeSink: Boolean(parsed.args.nativeSink),
            txHash: receipt.hash ?? receipt.transactionHash ?? null,
          };
        }
      } catch {
        /* not our event */
      }
    }
    return null;
  }

  return {
    router: routerAddr,
    registry: registryAddr,
    NATIVE,
    listCurrencies,
    isCurrencyAllowed,
    quoteWeight,
    accumulatedWeight,
    allowanceOf,
    balanceOf,
    buildApprove,
    buildBurn,
    dryRunTx: (tx) => dryRunTx(provider, tx),
    decodeBurnReceipt,
  };
}

export default {
  NATIVE,
  DEFAULT_CURRENCIES,
  BURN_ROUTER_ABI,
  BURN_REGISTRY_ABI,
  PRICE_SOURCE_ABI,
  routerIface,
  registryIface,
  priceSourceIface,
  isNative,
  decodeBurnRevert,
  dryRunTx,
  createBurnToMine,
};
