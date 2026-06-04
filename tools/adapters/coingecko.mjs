// coingecko.mjs — typed CoinGecko client (W2).
//
// Covers two free-tier endpoints used by the wallet/aggregator:
//   - GET /simple/price        -> spot prices for coin ids vs fiat/crypto
//   - GET /coins/markets       -> market rows (price, mcap, volume, change)
//
// Wired through the base layer: rate-limited, TTL-cached, retrying, typed
// errors, and fixture mode for offline tests. An optional API key is sent as
// the documented free-tier header when provided.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "./base.mjs";

export const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
// Pro/demo key header per CoinGecko docs. Free demo keys use this same header.
const API_KEY_HEADER = "x-cg-demo-api-key";

export class CoinGeckoClient {
  constructor({
    baseUrl = COINGECKO_BASE_URL,
    apiKey = null,
    fixtureMode = false,
    // Free tier is ~10-30 calls/min; default to a conservative bucket.
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 0.5 }),
    cache = new TTLCache({ ttlMs: 60_000 }),
    http = null, // inject a pre-built HttpClient (tests do this)
    ...httpOpts
  } = {}) {
    const defaultHeaders = apiKey ? { [API_KEY_HEADER]: apiKey } : {};
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        // Map each endpoint call to its fixture file when in fixture mode.
        fixtureResolver: (url) => coingeckoFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /simple/price?ids=a,b&vs_currencies=usd,eur[&include_24hr_change=true]
  // Returns the raw CoinGecko shape: { [id]: { [vs]: number, ... } }, plus a
  // typed accessor convenience via priceOf().
  async simplePrice({ ids, vsCurrencies = ["usd"], include24hrChange = false } = {}) {
    const idList = normList(ids, "ids");
    const vsList = normList(vsCurrencies, "vsCurrencies");
    const params = new URLSearchParams({
      ids: idList.join(","),
      vs_currencies: vsList.join(","),
    });
    if (include24hrChange) params.set("include_24hr_change", "true");

    const raw = await this.http.getJson(`/simple/price?${params.toString()}`, {
      fixture: "coingecko-simple-price",
    });
    return shapeSimplePrice(raw, idList, vsList);
  }

  // GET /coins/markets?vs_currency=usd&ids=a,b  (or order/per_page for top-N)
  // Returns an array of typed market rows.
  async coinsMarkets({ vsCurrency = "usd", ids = null, order = "market_cap_desc", perPage = 100, page = 1 } = {}) {
    const params = new URLSearchParams({
      vs_currency: String(vsCurrency),
      order: String(order),
      per_page: String(perPage),
      page: String(page),
    });
    if (ids) params.set("ids", normList(ids, "ids").join(","));

    const raw = await this.http.getJson(`/coins/markets?${params.toString()}`, {
      fixture: "coingecko-coins-markets",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("coins/markets: expected an array payload", { details: { got: typeof raw } });
    }
    return raw.map(shapeMarketRow);
  }
}

// ---- shaping / typing helpers -------------------------------------------

function normList(v, name) {
  if (v == null) throw new AdapterError(`${name} is required`);
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const cleaned = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) throw new AdapterError(`${name} must be non-empty`);
  return cleaned;
}

// Normalise simple/price into { prices: {id:{vs:{price, change24h?}}}, raw }.
function shapeSimplePrice(raw, idList, vsList) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("simple/price: unexpected payload", { details: { got: typeof raw } });
  }
  const prices = {};
  for (const id of idList) {
    const row = raw[id];
    if (row == null) continue; // CoinGecko omits unknown ids
    prices[id] = {};
    for (const vs of vsList) {
      if (row[vs] == null) continue;
      prices[id][vs] = {
        price: Number(row[vs]),
        change24h: row[`${vs}_24h_change`] != null ? Number(row[`${vs}_24h_change`]) : null,
      };
    }
  }
  return { prices, raw };
}

// Convenience: pull one price out of a shaped simple/price result.
export function priceOf(shaped, id, vs = "usd") {
  return shaped?.prices?.[String(id).toLowerCase()]?.[String(vs).toLowerCase()]?.price ?? null;
}

function shapeMarketRow(r) {
  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    price: r.current_price != null ? Number(r.current_price) : null,
    marketCap: r.market_cap != null ? Number(r.market_cap) : null,
    marketCapRank: r.market_cap_rank ?? null,
    volume24h: r.total_volume != null ? Number(r.total_volume) : null,
    change24hPct: r.price_change_percentage_24h != null ? Number(r.price_change_percentage_24h) : null,
    lastUpdated: r.last_updated ?? null,
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
function coingeckoFixtureName(url) {
  if (url.includes("/simple/price")) return "coingecko-simple-price";
  if (url.includes("/coins/markets")) return "coingecko-coins-markets";
  return null;
}
