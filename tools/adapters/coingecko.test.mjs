// coingecko.test.mjs — offline tests for the CoinGecko adapter (W2).
import { test } from "node:test";
import assert from "node:assert/strict";

import { CoinGeckoClient, priceOf, COINGECKO_BASE_URL } from "./coingecko.mjs";
import { HttpClient, AdapterError, UpstreamError } from "./base.mjs";

function fixtureClient(opts = {}) {
  return new CoinGeckoClient({ fixtureMode: true, ...opts });
}

test("simplePrice shapes typed prices + change", async () => {
  const cg = fixtureClient();
  const out = await cg.simplePrice({
    ids: ["bitcoin", "ethereum"],
    vsCurrencies: ["usd", "eur"],
    include24hrChange: true,
  });
  assert.equal(out.prices.bitcoin.usd.price, 67234.0);
  assert.equal(out.prices.bitcoin.usd.change24h, -1.2345);
  assert.equal(out.prices.ethereum.eur.price, 3233.1);
  // priceOf convenience
  assert.equal(priceOf(out, "ethereum", "usd"), 3512.77);
  assert.equal(priceOf(out, "nope", "usd"), null);
});

test("simplePrice requires non-empty ids", async () => {
  const cg = fixtureClient();
  await assert.rejects(() => cg.simplePrice({ ids: [] }), AdapterError);
  await assert.rejects(() => cg.simplePrice({}), AdapterError);
});

test("coinsMarkets returns typed rows", async () => {
  const cg = fixtureClient();
  const rows = await cg.coinsMarkets({ vsCurrency: "usd", ids: ["bitcoin", "ethereum"] });
  assert.equal(rows.length, 2);
  const btc = rows[0];
  assert.equal(btc.id, "bitcoin");
  assert.equal(btc.symbol, "btc");
  assert.equal(btc.marketCapRank, 1);
  assert.equal(btc.change24hPct, -1.2345);
  assert.equal(typeof btc.price, "number");
});

test("API key is sent as the demo header when provided", () => {
  const cg = new CoinGeckoClient({ fixtureMode: true, apiKey: "CG-test-123" });
  assert.equal(cg.http.defaultHeaders["x-cg-demo-api-key"], "CG-test-123");
});

test("base url default points at the public v3 API", () => {
  assert.match(COINGECKO_BASE_URL, /api\.coingecko\.com\/api\/v3$/);
});

// error mapping through the injected HttpClient (simulate a 429)
test("upstream 429 surfaces as RateLimitError (no retries left)", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => "rl",
    }),
  });
  const cg = new CoinGeckoClient({ http });
  await assert.rejects(() => cg.simplePrice({ ids: ["bitcoin"] }), (e) => {
    assert.equal(e.name, "RateLimitError");
    return true;
  });
});

test("non-array coins/markets payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "an array" }) }),
  });
  const cg = new CoinGeckoClient({ http });
  await assert.rejects(() => cg.coinsMarkets({ ids: ["bitcoin"] }), AdapterError);
});
