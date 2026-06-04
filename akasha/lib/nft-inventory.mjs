/**
 * nft-inventory.mjs — AK7
 *
 * Headless NFT-inventory reader for the Akasha wallet. Given a list of NFT
 * contract addresses (sourced from deployments.json / a token-list / the
 * contract-registry) and an owner address, it returns the owner's holdings
 * across ERC-721 and ERC-1155 collections:
 *
 *   [{ contract, standard, name?, symbol?, tokenId, balance, tokenURI?, metadata? }]
 *
 * Design mirrors the rest of lib/ (token-list.mjs / balance-dashboard.mjs):
 *   - ethers v6 `Interface` for encode/decode; no Contract instances needed.
 *   - the provider only needs an ethers-style `call({to,data}) -> hexString`,
 *     which makes both the live path and the tests trivially mockable.
 *   - a FIXTURE-mode fallback (`{ fixtures }`) so the UI renders with no node.
 *
 * Enumeration strategy (no indexer, pure RPC):
 *   ERC-721  — preferred: ERC-721 Enumerable (balanceOf + tokenOfOwnerByIndex).
 *              If a collection is not Enumerable, the caller may pass candidate
 *              `tokenIds` to probe with ownerOf (best-effort).
 *   ERC-1155 — there is no on-chain "list my ids"; the caller passes candidate
 *              `tokenIds` per contract and we read balanceOf(owner,id) for each
 *              (balanceOfBatch when several). Rows with balance 0 are dropped.
 *
 * Standard is detected via ERC-165 supportsInterface, falling back to a probe
 * (try Enumerable balanceOf+tokenOfOwnerByIndex shapes) — but a caller may also
 * declare `{ address, standard, tokenIds }` up front to skip detection.
 *
 * Metadata is best-effort and network-guarded: tokenURI/uri is read on-chain,
 * then (if `opts.fetchMetadata`) the JSON is fetched with a timeout + abort.
 * Any failure leaves `metadata` undefined and never throws the whole read.
 *
 * @typedef {'erc721'|'erc1155'} NftStandard
 *
 * @typedef {Object} NftHolding
 * @property {string} contract          Checksummed collection address.
 * @property {NftStandard} standard
 * @property {string} [name]            Collection name (ERC-721 metadata).
 * @property {string} [symbol]          Collection symbol (ERC-721 metadata).
 * @property {string} tokenId           Decimal string (uint256-safe).
 * @property {bigint} balance           1n for 721; the held amount for 1155.
 * @property {string} [tokenURI]        Raw token URI (721 tokenURI / 1155 uri).
 * @property {Object} [metadata]        Parsed JSON metadata, if fetched.
 *
 * @typedef {Object} NftCollectionSpec
 * @property {string} address
 * @property {NftStandard} [standard]   Declare to skip ERC-165 detection.
 * @property {Array<string|number|bigint>} [tokenIds]
 *           Candidate ids to probe (required for 1155 + non-Enumerable 721).
 * @property {string} [name]
 * @property {string} [symbol]
 */

import { Interface, getAddress, isAddress } from 'ethers';

// ERC-165 interface ids (4-byte selectors of the standard interface).
const IFACE_ID_ERC721 = '0x80ac58cd';
const IFACE_ID_ERC721_ENUMERABLE = '0x780e9d63';
const IFACE_ID_ERC721_METADATA = '0x5b5e139f';
const IFACE_ID_ERC1155 = '0xd9b67a26';

/** Minimal multi-standard NFT interface (read-only surface we touch). */
const NFT_IFACE = new Interface([
  // ERC-165
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  // ERC-721 + Enumerable + Metadata
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  // ERC-1155
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function uri(uint256 id) view returns (string)',
]);

// ethers overloads name() collisions by signature; cache the exact fragments.
const SIG = {
  supportsInterface: 'supportsInterface(bytes4)',
  balanceOf721: 'balanceOf(address)',
  balanceOf1155: 'balanceOf(address,uint256)',
  ownerOf: 'ownerOf(uint256)',
  tokenOfOwnerByIndex: 'tokenOfOwnerByIndex(address,uint256)',
  tokenURI: 'tokenURI(uint256)',
  uri: 'uri(uint256)',
  name: 'name()',
  symbol: 'symbol()',
};

const enc = (sig, args = []) => NFT_IFACE.encodeFunctionData(sig, args);
const dec = (sig, raw) => NFT_IFACE.decodeFunctionResult(sig, raw);

/** Normalize any id form to a decimal string (uint256-safe). */
function toIdString(id) {
  if (typeof id === 'bigint') return id.toString();
  if (typeof id === 'number') return BigInt(id).toString();
  if (typeof id === 'string') return BigInt(id).toString(); // accepts hex or dec
  throw new Error(`nft-inventory: invalid tokenId ${JSON.stringify(id)}`);
}

/**
 * EIP-1155/721 URI templating: `{id}` is replaced with the lowercase, zero-padded
 * 64-hex-char form of the token id (ERC-1155 §metadata). Harmless for 721.
 * @param {string} uri
 * @param {string} tokenId  decimal string
 */
export function expandTokenUri(uri, tokenId) {
  if (typeof uri !== 'string' || !uri.includes('{id}')) return uri;
  const hex = BigInt(tokenId).toString(16).padStart(64, '0');
  return uri.replaceAll('{id}', hex);
}

/**
 * Resolve a token URI to something fetchable. Handles ipfs:// and bare CIDs via
 * an optional gateway; data: URIs are returned as-is (parsed without network).
 * @param {string} uri
 * @param {string} [ipfsGateway='https://ipfs.io/ipfs/']
 */
export function resolveUri(uri, ipfsGateway = 'https://ipfs.io/ipfs/') {
  if (typeof uri !== 'string' || uri.length === 0) return uri;
  if (uri.startsWith('ipfs://')) {
    return ipfsGateway + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  }
  return uri;
}

/**
 * Best-effort metadata fetch — never throws; returns undefined on any failure.
 * Parses inline `data:application/json` URIs without touching the network.
 * @param {string} uri  already-expanded, already-resolved URI
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetch]  injectable fetch (tests)
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<Object|undefined>}
 */
export async function fetchMetadata(uri, opts = {}) {
  if (typeof uri !== 'string' || uri.length === 0) return undefined;

  // data: URI — decode locally, no network.
  if (uri.startsWith('data:')) {
    try {
      const comma = uri.indexOf(',');
      if (comma < 0) return undefined;
      const meta = uri.slice(0, comma);
      const payload = uri.slice(comma + 1);
      const json = meta.includes(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  }

  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return undefined; // no fetch available → skip gracefully
  if (!/^https?:\/\//i.test(uri)) return undefined; // unsupported scheme

  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    // Don't let the timeout hold the event loop open (node) — browsers ignore.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  try {
    const res = await doFetch(uri, controller ? { signal: controller.signal } : undefined);
    if (!res || !res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined; // network error / abort / non-JSON → guarded
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Detect the NFT standard of a contract via ERC-165 supportsInterface.
 * Returns 'erc721' | 'erc1155' | null (unknown / not an NFT).
 * @param {{call: Function}} provider
 * @param {string} contract  checksummed address
 * @returns {Promise<{standard: NftStandard|null, enumerable: boolean}>}
 */
export async function detectStandard(provider, contract) {
  const supports = async (id) => {
    try {
      const raw = await provider.call({ to: contract, data: enc(SIG.supportsInterface, [id]) });
      return Boolean(dec(SIG.supportsInterface, raw)[0]);
    } catch {
      return false;
    }
  };
  if (await supports(IFACE_ID_ERC721)) {
    const enumerable = await supports(IFACE_ID_ERC721_ENUMERABLE);
    return { standard: 'erc721', enumerable };
  }
  if (await supports(IFACE_ID_ERC1155)) {
    return { standard: 'erc1155', enumerable: false };
  }
  return { standard: null, enumerable: false };
}

/** Read ERC-721 name()/symbol() best-effort (returns {} on failure). */
async function read721Identity(provider, contract) {
  const out = {};
  try {
    out.name = dec(SIG.name, await provider.call({ to: contract, data: enc(SIG.name) }))[0];
  } catch {
    /* optional */
  }
  try {
    out.symbol = dec(SIG.symbol, await provider.call({ to: contract, data: enc(SIG.symbol) }))[0];
  } catch {
    /* optional */
  }
  return out;
}

/**
 * Enumerate one ERC-721 collection for `owner`.
 * Uses Enumerable (tokenOfOwnerByIndex) when available; otherwise probes the
 * caller-supplied `tokenIds` with ownerOf.
 * @returns {Promise<NftHolding[]>}
 */
async function read721(provider, spec, owner) {
  const contract = spec.address;
  const ident = await read721Identity(provider, contract);
  const name = spec.name ?? ident.name;
  const symbol = spec.symbol ?? ident.symbol;
  const ids = [];

  let enumerable = spec.enumerable;
  if (enumerable === undefined) {
    enumerable = (await detectStandard(provider, contract)).enumerable;
  }

  if (enumerable) {
    let bal = 0n;
    try {
      bal = BigInt(dec(SIG.balanceOf721, await provider.call({ to: contract, data: enc(SIG.balanceOf721, [owner]) }))[0]);
    } catch {
      bal = 0n;
    }
    for (let i = 0n; i < bal; i++) {
      try {
        const raw = await provider.call({
          to: contract,
          data: enc(SIG.tokenOfOwnerByIndex, [owner, i]),
        });
        ids.push(BigInt(dec(SIG.tokenOfOwnerByIndex, raw)[0]).toString());
      } catch {
        break; // bail out of a broken enumeration rather than hang
      }
    }
  } else if (Array.isArray(spec.tokenIds)) {
    // Non-enumerable: probe candidate ids with ownerOf.
    const want = owner.toLowerCase();
    for (const candidate of spec.tokenIds) {
      const id = toIdString(candidate);
      try {
        const raw = await provider.call({ to: contract, data: enc(SIG.ownerOf, [id]) });
        const holder = String(dec(SIG.ownerOf, raw)[0]).toLowerCase();
        if (holder === want) ids.push(id);
      } catch {
        /* unminted / reverts → skip */
      }
    }
  }

  return ids.map((tokenId) => ({
    contract,
    standard: /** @type {NftStandard} */ ('erc721'),
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    tokenId,
    balance: 1n,
  }));
}

/**
 * Read ERC-1155 balances for `owner` across the caller-supplied candidate ids.
 * @returns {Promise<NftHolding[]>}
 */
async function read1155(provider, spec, owner) {
  const contract = spec.address;
  if (!Array.isArray(spec.tokenIds) || spec.tokenIds.length === 0) return [];
  const rows = [];
  for (const candidate of spec.tokenIds) {
    const tokenId = toIdString(candidate);
    let balance = 0n;
    try {
      const raw = await provider.call({
        to: contract,
        data: enc(SIG.balanceOf1155, [owner, tokenId]),
      });
      balance = BigInt(dec(SIG.balanceOf1155, raw)[0]);
    } catch {
      balance = 0n;
    }
    if (balance > 0n) {
      rows.push({
        contract,
        standard: /** @type {NftStandard} */ ('erc1155'),
        ...(spec.name ? { name: spec.name } : {}),
        tokenId,
        balance,
      });
    }
  }
  return rows;
}

/**
 * Attach tokenURI (+ optional fetched metadata) to a set of holdings, in place.
 * 721 → tokenURI(id); 1155 → uri(id) with {id} templating. Network-guarded.
 * @param {{call: Function}} provider
 * @param {NftHolding[]} holdings
 * @param {Object} [opts]
 * @param {boolean} [opts.fetchMetadata=false]
 * @param {string} [opts.ipfsGateway]
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 */
export async function attachUris(provider, holdings, opts = {}) {
  for (const h of holdings) {
    let uri;
    try {
      if (h.standard === 'erc721') {
        const raw = await provider.call({ to: h.contract, data: enc(SIG.tokenURI, [h.tokenId]) });
        uri = dec(SIG.tokenURI, raw)[0];
      } else {
        const raw = await provider.call({ to: h.contract, data: enc(SIG.uri, [h.tokenId]) });
        uri = dec(SIG.uri, raw)[0];
      }
    } catch {
      uri = undefined; // no metadata extension / reverts → leave undefined
    }
    if (typeof uri === 'string' && uri.length > 0) {
      const expanded = expandTokenUri(uri, h.tokenId);
      h.tokenURI = expanded;
      if (opts.fetchMetadata) {
        const resolved = resolveUri(expanded, opts.ipfsGateway);
        const meta = await fetchMetadata(resolved, { fetch: opts.fetch, timeoutMs: opts.timeoutMs });
        if (meta) h.metadata = meta;
      }
    }
  }
  return holdings;
}

/**
 * MAIN ENTRY — read an owner's NFT inventory across a set of collections.
 *
 * Live mode: pass `provider` (ethers-style `call`) + `collections` specs.
 * Fixture mode: pass `{ fixtures }` (an array of NftHolding-shaped rows, or a
 * map keyed by owner) and NO live calls are made — the UI renders offline.
 *
 * @param {Object} args
 * @param {{call: Function}} [args.provider]
 * @param {string} args.owner
 * @param {NftCollectionSpec[]} [args.collections]
 * @param {NftHolding[] | Record<string, NftHolding[]>} [args.fixtures]
 *        Fixture rows. If a map, looked up by lowercased owner; else used as-is.
 * @param {boolean} [args.withUris=true]    Read tokenURI for each holding.
 * @param {boolean} [args.fetchMetadata=false]  Also fetch + parse metadata JSON.
 * @param {string} [args.ipfsGateway]
 * @param {typeof fetch} [args.fetch]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<NftHolding[]>}
 */
export async function readInventory(args = {}) {
  const { owner } = args;
  if (typeof owner !== 'string' || !isAddress(owner)) {
    throw new Error(`nft-inventory: invalid owner ${JSON.stringify(owner)}`);
  }
  const ownerCs = getAddress(owner);

  // ---- FIXTURE MODE (no live node) -----------------------------------------
  if (args.fixtures !== undefined) {
    let rows;
    if (Array.isArray(args.fixtures)) {
      rows = args.fixtures;
    } else if (args.fixtures && typeof args.fixtures === 'object') {
      rows = args.fixtures[ownerCs.toLowerCase()] || args.fixtures[ownerCs] || [];
    } else {
      rows = [];
    }
    // Normalize fixture rows into the canonical holding shape.
    return rows.map((r) => ({
      contract: isAddress(r.contract) ? getAddress(r.contract) : r.contract,
      standard: r.standard,
      ...(r.name ? { name: r.name } : {}),
      ...(r.symbol ? { symbol: r.symbol } : {}),
      tokenId: toIdString(r.tokenId),
      balance: typeof r.balance === 'bigint' ? r.balance : BigInt(r.balance ?? 1),
      ...(r.tokenURI ? { tokenURI: r.tokenURI } : {}),
      ...(r.metadata ? { metadata: r.metadata } : {}),
    }));
  }

  // ---- LIVE MODE -----------------------------------------------------------
  const provider = args.provider;
  if (!provider || typeof provider.call !== 'function') {
    throw new Error('nft-inventory: provider with a call() method is required (or pass fixtures)');
  }
  const collections = Array.isArray(args.collections) ? args.collections : [];

  const all = [];
  for (const raw of collections) {
    if (!raw || !isAddress(raw.address)) continue;
    const address = getAddress(raw.address);
    const spec = { ...raw, address };

    let standard = spec.standard;
    if (!standard) {
      const det = await detectStandard(provider, address);
      standard = det.standard;
      spec.enumerable = det.enumerable;
    }
    if (standard === 'erc721') {
      all.push(...(await read721(provider, spec, ownerCs)));
    } else if (standard === 'erc1155') {
      all.push(...(await read1155(provider, spec, ownerCs)));
    }
    // unknown standard → skip
  }

  if (args.withUris !== false) {
    await attachUris(provider, all, {
      fetchMetadata: Boolean(args.fetchMetadata),
      ipfsGateway: args.ipfsGateway,
      fetch: args.fetch,
      timeoutMs: args.timeoutMs,
    });
  }

  return all;
}

/**
 * Convenience: derive NFT collection specs from a contract-registry (Z1),
 * picking entries whose ABI exposes an NFT surface. ERC-1155 entries need
 * candidate ids supplied separately (`idsByName`), since they aren't on-chain
 * enumerable.
 * @param {import('./contract-registry.mjs').ContractRegistry} registry
 * @param {Object} [opts]
 * @param {Record<string, Array<string|number|bigint>>} [opts.idsByName]
 * @returns {NftCollectionSpec[]}
 */
export function collectionsFromRegistry(registry, opts = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new Error('collectionsFromRegistry: a contract registry (Z1) is required');
  }
  const idsByName = opts.idsByName || {};
  const specs = [];
  for (const name of registry.list()) {
    const entry = registry.get(name);
    if (!entry.address) continue;
    const surface = nftSurface(entry.abi);
    if (!surface) continue;
    const spec = { address: entry.address, name };
    if (surface === 'erc721' || surface === 'erc1155') spec.standard = surface;
    if (idsByName[name]) spec.tokenIds = idsByName[name];
    specs.push(spec);
  }
  return specs;
}

/**
 * Classify an ABI as an NFT surface: 'erc1155' if it has uri()+balanceOf(addr,id);
 * 'erc721' if it has ownerOf()+tokenURI(); else null.
 * @param {any[]} abi
 * @returns {NftStandard|null}
 */
export function nftSurface(abi) {
  if (!Array.isArray(abi)) return null;
  const fns = abi.filter((f) => f && f.type === 'function' && typeof f.name === 'string');
  const byName = new Set(fns.map((f) => f.name));
  const has1155Balance = fns.some(
    (f) => f.name === 'balanceOf' && Array.isArray(f.inputs) && f.inputs.length === 2,
  );
  if (byName.has('uri') && has1155Balance) return 'erc1155';
  if (byName.has('ownerOf') && byName.has('tokenURI')) return 'erc721';
  return null;
}

export default {
  readInventory,
  detectStandard,
  attachUris,
  fetchMetadata,
  expandTokenUri,
  resolveUri,
  collectionsFromRegistry,
  nftSurface,
};
