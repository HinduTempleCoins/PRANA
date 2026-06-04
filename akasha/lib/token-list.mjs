/**
 * token-list.mjs — Q6
 *
 * Token-list schema + loader for the Akasha wallet.
 *
 * SCHEMA (see also tokenlist.schema.json):
 *   {
 *     "name":    string,           // human label for the list
 *     "chainId": number,           // the chain these tokens live on
 *     "tokens": [
 *       {
 *         "address":  string,      // 0x… 20-byte address (will be EIP-55 checksummed)
 *         "symbol":   string,      // ticker, e.g. "PRANA"
 *         "name":     string,      // display name
 *         "decimals": number,      // integer 0..36
 *         "logoURI":  string?,     // optional icon URL
 *         "tags":     string[]?    // optional tag list
 *       }, ...
 *     ]
 *   }
 *
 * Exports:
 *   - loadTokenList(json)               validate shape + checksum every address
 *   - fromDeployments(registry, opts?)  auto-build a list from deployed ERC-20s
 *   - balancesOf(provider, list, account, opts?)  batched (Multicall) or sequential
 *
 * @typedef {Object} TokenInfo
 * @property {string} address
 * @property {string} symbol
 * @property {string} name
 * @property {number} decimals
 * @property {string} [logoURI]
 * @property {string[]} [tags]
 *
 * @typedef {Object} TokenList
 * @property {string} name
 * @property {number} chainId
 * @property {TokenInfo[]} tokens
 */

import { Interface, getAddress, isAddress } from 'ethers';

/** Minimal ERC-20 interface used for balance reads and surface detection. */
const ERC20_BALANCE_IFACE = new Interface([
  'function balanceOf(address) view returns (uint256)',
]);

/** Function names that together constitute the "ERC-20 surface" we require. */
const ERC20_REQUIRED_FNS = ['symbol', 'decimals', 'transfer'];

/**
 * Does an ABI (raw fragment array) expose enough ERC-20 surface to be a token?
 * We look for symbol() + decimals() + transfer(...) function fragments.
 * @param {any[]} abi
 * @returns {boolean}
 */
export function hasErc20Surface(abi) {
  if (!Array.isArray(abi)) return false;
  const fnNames = new Set(
    abi.filter((f) => f && f.type === 'function' && typeof f.name === 'string').map((f) => f.name),
  );
  return ERC20_REQUIRED_FNS.every((n) => fnNames.has(n));
}

/**
 * Validate + normalize one token entry. Returns a frozen, checksummed copy.
 * @param {any} entry
 * @param {number} index  For error messages.
 * @returns {TokenInfo}
 */
function normalizeToken(entry, index) {
  const where = `tokens[${index}]`;
  if (!entry || typeof entry !== 'object') throw new Error(`${where}: must be an object`);

  const { address, symbol, name, decimals, logoURI, tags } = entry;

  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error(`${where}: invalid address ${JSON.stringify(address)}`);
  }
  // getAddress also rejects a wrong checksum on already-mixed-case input.
  const checksummed = getAddress(address);

  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new Error(`${where} (${checksummed}): symbol must be a non-empty string`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${where} (${checksummed}): name must be a non-empty string`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${where} (${checksummed}): decimals must be an integer 0..36`);
  }

  /** @type {TokenInfo} */
  const out = { address: checksummed, symbol, name, decimals };
  if (logoURI !== undefined) {
    if (typeof logoURI !== 'string') throw new Error(`${where}: logoURI must be a string`);
    out.logoURI = logoURI;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`${where}: tags must be an array of strings`);
    }
    out.tags = [...tags];
  }
  return Object.freeze(out);
}

/**
 * Validate a token-list JSON object against the schema and checksum addresses.
 * Throws a descriptive Error on the first problem.
 * @param {any} json
 * @returns {TokenList}
 */
export function loadTokenList(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('token-list: top level must be an object');
  }
  if (typeof json.name !== 'string' || json.name.length === 0) {
    throw new Error('token-list: "name" must be a non-empty string');
  }
  if (!Number.isInteger(json.chainId) || json.chainId < 1) {
    throw new Error('token-list: "chainId" must be a positive integer');
  }
  if (!Array.isArray(json.tokens)) {
    throw new Error('token-list: "tokens" must be an array');
  }

  const seenAddr = new Set();
  const tokens = json.tokens.map((t, i) => {
    const tok = normalizeToken(t, i);
    const key = tok.address.toLowerCase();
    if (seenAddr.has(key)) throw new Error(`token-list: duplicate address ${tok.address}`);
    seenAddr.add(key);
    return tok;
  });

  return Object.freeze({
    name: json.name,
    chainId: json.chainId,
    ...(json.version ? { version: json.version } : {}),
    tokens,
  });
}

/**
 * Auto-build a validated token list from a contract registry (Z1), selecting
 * every contract whose ABI has the ERC-20 surface AND has a deployed address.
 *
 * Symbol/name/decimals are not read from chain here (that needs a provider);
 * we seed symbol=name=contract-name and decimals=18, which the wallet can
 * refine later via on-chain reads. Pass `defaults` to override.
 *
 * @param {import('./contract-registry.mjs').ContractRegistry} registry
 * @param {Object} [opts]
 * @param {string} [opts.name="PRANA deployed tokens"]
 * @param {Object} [opts.defaults]  Per-token defaults { decimals }.
 * @returns {TokenList}
 */
export function fromDeployments(registry, opts = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new Error('fromDeployments: a contract registry (Z1) is required');
  }
  const decimals = opts.defaults?.decimals ?? 18;
  const tokens = [];
  for (const name of registry.list()) {
    const entry = registry.get(name);
    if (!entry.address) continue; // not deployed on this chain
    if (!hasErc20Surface(entry.abi)) continue; // not a token
    tokens.push({ address: entry.address, symbol: name, name, decimals });
  }
  return loadTokenList({
    name: opts.name || 'PRANA deployed tokens',
    chainId: Number(registry.chainId),
    tokens,
  });
}

/**
 * Read ERC-20 balances of `account` for every token in `list`.
 *
 * If a Multicall contract is deployed in the registry (`opts.registry`), the
 * reads are batched through Multicall.aggregate(); otherwise we fall back to
 * one provider.call per token, sequentially.
 *
 * The provider only needs an ethers-style `call({ to, data }) -> hexString`.
 * That makes the multicall/sequential paths trivially mockable in tests.
 *
 * @param {{ call: (tx: {to:string,data:string}) => Promise<string> }} provider
 * @param {TokenList} list
 * @param {string} account
 * @param {Object} [opts]
 * @param {import('./contract-registry.mjs').ContractRegistry} [opts.registry]
 *        Registry to source the Multicall address+ABI from.
 * @param {string} [opts.multicallName="Multicall"]
 * @returns {Promise<Array<{address:string, symbol:string, decimals:number, balance:bigint}>>}
 */
export async function balancesOf(provider, list, account, opts = {}) {
  if (!provider || typeof provider.call !== 'function') {
    throw new Error('balancesOf: provider with a call() method is required');
  }
  if (!isAddress(account)) throw new Error(`balancesOf: invalid account ${account}`);
  const acct = getAddress(account);
  const tokens = list.tokens;

  const decode = (token, raw) => {
    let balance = 0n;
    try {
      // balanceOf returns a single uint256.
      balance = BigInt(ERC20_BALANCE_IFACE.decodeFunctionResult('balanceOf', raw)[0]);
    } catch {
      balance = 0n;
    }
    return { address: token.address, symbol: token.symbol, decimals: token.decimals, balance };
  };

  const callData = (token) =>
    ERC20_BALANCE_IFACE.encodeFunctionData('balanceOf', [acct]);

  // --- Multicall batched path -------------------------------------------------
  const multicallName = opts.multicallName || 'Multicall';
  const mc =
    opts.registry && opts.registry.has(multicallName) ? opts.registry.get(multicallName) : null;

  if (mc && mc.address) {
    const calls = tokens.map((t) => ({ target: t.address, callData: callData(t) }));
    const data = mc.iface.encodeFunctionData('aggregate', [calls]);
    const raw = await provider.call({ to: mc.address, data });
    const [, returnData] = mc.iface.decodeFunctionResult('aggregate', raw);
    return tokens.map((t, i) => decode(t, returnData[i]));
  }

  // --- Sequential fallback ----------------------------------------------------
  const out = [];
  for (const t of tokens) {
    const raw = await provider.call({ to: t.address, data: callData(t) });
    out.push(decode(t, raw));
  }
  return out;
}

export default { loadTokenList, fromDeployments, balancesOf, hasErc20Surface };
