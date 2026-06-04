// defillama.mjs — typed DefiLlama client (W3).
//
// Read-only, no API key. Covers:
//   - TVL:    GET https://api.llama.fi/protocols      (all protocols)
//             GET https://api.llama.fi/protocol/{slug} (one protocol detail)
//             GET https://api.llama.fi/v2/chains      (per-chain TVL)
//   - Yields: GET https://yields.llama.fi/pools       (pool APYs)
//
// Note: DefiLlama splits TVL and yields across two hosts, so this client holds
// two HttpClients sharing the same base-layer policy (rate limit + cache +
// retry + fixtures).

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "./base.mjs";

export const DEFILLAMA_TVL_BASE = "https://api.llama.fi";
export const DEFILLAMA_YIELDS_BASE = "https://yields.llama.fi";

export class DefiLlamaClient {
  constructor({
    tvlBaseUrl = DEFILLAMA_TVL_BASE,
    yieldsBaseUrl = DEFILLAMA_YIELDS_BASE,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
    tvlHttp = null,
    yieldsHttp = null,
    ...httpOpts
  } = {}) {
    const common = { fixtureMode, rateLimiter, cache, ...httpOpts };
    this.tvlHttp =
      tvlHttp ??
      new HttpClient({ baseUrl: tvlBaseUrl, fixtureResolver: defillamaFixtureName, ...common });
    this.yieldsHttp =
      yieldsHttp ??
      new HttpClient({ baseUrl: yieldsBaseUrl, fixtureResolver: defillamaFixtureName, ...common });
  }

  // GET /protocols -> array of protocol summaries.
  async protocols() {
    const raw = await this.tvlHttp.getJson("/protocols", { fixture: "defillama-protocols" });
    if (!Array.isArray(raw)) {
      throw new AdapterError("protocols: expected an array payload", { details: { got: typeof raw } });
    }
    return raw.map(shapeProtocol);
  }

  // GET /v2/chains -> array of per-chain TVL.
  async chains() {
    const raw = await this.tvlHttp.getJson("/v2/chains", { fixture: "defillama-chains" });
    if (!Array.isArray(raw)) {
      throw new AdapterError("chains: expected an array payload", { details: { got: typeof raw } });
    }
    return raw.map(shapeChain);
  }

  // GET /pools (yields). Response is { status, data: [...] }.
  async pools() {
    const raw = await this.yieldsHttp.getJson("/pools", { fixture: "defillama-pools" });
    const data = raw?.data;
    if (!Array.isArray(data)) {
      throw new AdapterError("pools: expected { data: [...] } payload", { details: { got: typeof data } });
    }
    return data.map(shapePool);
  }
}

// ---- shaping / typing helpers -------------------------------------------

function shapeProtocol(p) {
  return {
    id: p.id ?? null,
    name: p.name,
    slug: p.slug ?? null,
    symbol: p.symbol ?? null,
    category: p.category ?? null,
    chains: Array.isArray(p.chains) ? p.chains : [],
    tvl: p.tvl != null ? Number(p.tvl) : null,
    change1d: p.change_1d != null ? Number(p.change_1d) : null,
    change7d: p.change_7d != null ? Number(p.change_7d) : null,
  };
}

function shapeChain(c) {
  return {
    name: c.name,
    geckoId: c.gecko_id ?? null,
    tokenSymbol: c.tokenSymbol ?? null,
    chainId: c.chainId ?? null,
    tvl: c.tvl != null ? Number(c.tvl) : null,
  };
}

function shapePool(p) {
  return {
    pool: p.pool,
    project: p.project,
    chain: p.chain,
    symbol: p.symbol,
    tvlUsd: p.tvlUsd != null ? Number(p.tvlUsd) : null,
    apy: p.apy != null ? Number(p.apy) : null,
    apyBase: p.apyBase != null ? Number(p.apyBase) : null,
    apyReward: p.apyReward != null ? Number(p.apyReward) : null,
    stablecoin: Boolean(p.stablecoin),
  };
}

function defillamaFixtureName(url) {
  if (url.includes("/protocols")) return "defillama-protocols";
  if (url.includes("/v2/chains")) return "defillama-chains";
  if (url.includes("/pools")) return "defillama-pools";
  return null;
}
