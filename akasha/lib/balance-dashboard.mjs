/**
 * balance-dashboard.mjs — Z3
 *
 * Headless balance-dashboard model for the Akasha wallet home screen.
 *
 * Given (provider, tokenList, account) it produces a list of display rows:
 *   { kind:'native'|'token', address|null, symbol, name, decimals, balance, formatted }
 * one native (PRANA) row plus one row per ERC-20 in the token list. Token
 * balances are batched through the Multicall path already implemented in
 * token-list.mjs `balancesOf` (we REUSE it — no duplicate multicall code here).
 *
 * `refresh()` re-reads and returns change detection so the React shell can do a
 * cheap, targeted re-render:
 *   { rows, changed:[address|'native', …], dirty:boolean }
 *
 * The provider only needs:
 *   - `call({to,data}) -> Promise<hexString>`        (used by balancesOf)
 *   - `getBalance(address) -> Promise<bigint>`        (native balance)
 * Both are satisfied by an ethers v6 provider and are trivially mockable.
 */

import { formatUnits, getAddress, isAddress } from 'ethers';
import { balancesOf } from './token-list.mjs';

const NATIVE_KEY = 'native';

/**
 * @param {object} provider  ethers-style provider ({call, getBalance})
 * @param {import('./token-list.mjs').TokenList} tokenList
 * @param {string} account
 * @param {object} [opts]
 * @param {import('./contract-registry.mjs').ContractRegistry} [opts.registry]  enables Multicall batching
 * @param {string} [opts.nativeSymbol='PRANA']
 * @param {string} [opts.nativeName='PRANA']
 * @param {number} [opts.nativeDecimals=18]
 * @param {number} [opts.displayDecimals]  truncate `formatted` to N places (default: full)
 */
export function createBalanceDashboard(provider, tokenList, account, opts = {}) {
  if (!provider || typeof provider.call !== 'function') {
    throw new Error('balance-dashboard: provider with call() is required');
  }
  if (typeof provider.getBalance !== 'function') {
    throw new Error('balance-dashboard: provider with getBalance() is required');
  }
  if (!isAddress(account)) throw new Error(`balance-dashboard: invalid account ${account}`);

  const acct = getAddress(account);
  const nativeSymbol = opts.nativeSymbol ?? 'PRANA';
  const nativeName = opts.nativeName ?? 'PRANA';
  const nativeDecimals = opts.nativeDecimals ?? 18;
  const displayDecimals = opts.displayDecimals;

  // token metadata, keyed by checksummed address, for fast row assembly
  const tokenMeta = new Map();
  for (const t of tokenList.tokens) {
    tokenMeta.set(t.address, { name: t.name, logoURI: t.logoURI });
  }

  // last-known balances keyed by NATIVE_KEY / token address -> bigint
  let lastBalances = new Map();
  let rows = [];

  const fmt = (balance, decimals) => {
    const s = formatUnits(balance, decimals);
    if (displayDecimals == null) return s;
    const [int, frac = ''] = s.split('.');
    return frac ? `${int}.${frac.slice(0, displayDecimals)}` : int;
  };

  async function read() {
    const [nativeBal, tokenRows] = await Promise.all([
      provider.getBalance(acct).then((v) => BigInt(v)),
      balancesOf(provider, tokenList, acct, { registry: opts.registry, multicallName: opts.multicallName }),
    ]);

    const next = new Map();
    next.set(NATIVE_KEY, nativeBal);

    const nativeRow = {
      kind: 'native',
      address: null,
      symbol: nativeSymbol,
      name: nativeName,
      decimals: nativeDecimals,
      balance: nativeBal,
      formatted: fmt(nativeBal, nativeDecimals),
    };

    const erc20Rows = tokenRows.map((r) => {
      next.set(r.address, r.balance);
      const meta = tokenMeta.get(r.address) ?? {};
      return {
        kind: 'token',
        address: r.address,
        symbol: r.symbol,
        name: meta.name ?? r.symbol,
        decimals: r.decimals,
        balance: r.balance,
        formatted: fmt(r.balance, r.decimals),
        ...(meta.logoURI ? { logoURI: meta.logoURI } : {}),
      };
    });

    return { rows: [nativeRow, ...erc20Rows], balances: next };
  }

  return {
    /** Current rows (empty until the first load/refresh). */
    get rows() {
      return rows;
    },

    /** First read — no change detection (everything is "new"). */
    async load() {
      const r = await read();
      rows = r.rows;
      lastBalances = r.balances;
      return rows;
    },

    /**
     * Re-read and diff against the previous balances.
     * @returns {Promise<{rows, changed:string[], dirty:boolean}>}
     */
    async refresh() {
      const r = await read();
      const changed = [];
      for (const [key, val] of r.balances) {
        if (lastBalances.get(key) !== val) changed.push(key);
      }
      // also flag rows that disappeared (token removed from list)
      for (const key of lastBalances.keys()) {
        if (!r.balances.has(key)) changed.push(key);
      }
      rows = r.rows;
      lastBalances = r.balances;
      return { rows, changed, dirty: changed.length > 0 };
    },
  };
}

export default { createBalanceDashboard };
