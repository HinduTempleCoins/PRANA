// defillama.test.mjs — offline tests for the DefiLlama adapter (W3).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DefiLlamaClient, DEFILLAMA_TVL_BASE, DEFILLAMA_YIELDS_BASE } from "./defillama.mjs";
import { HttpClient, AdapterError } from "./base.mjs";

function fixtureClient(opts = {}) {
  return new DefiLlamaClient({ fixtureMode: true, ...opts });
}

test("protocols returns typed protocol rows", async () => {
  const dl = fixtureClient();
  const rows = await dl.protocols();
  assert.equal(rows.length, 2);
  const aave = rows[0];
  assert.equal(aave.name, "Aave");
  assert.equal(aave.slug, "aave");
  assert.equal(aave.category, "Lending");
  assert.deepEqual(aave.chains, ["Ethereum", "Polygon", "Avalanche"]);
  assert.equal(typeof aave.tvl, "number");
  assert.equal(aave.change1d, 0.83);
});

test("chains returns per-chain TVL", async () => {
  const dl = fixtureClient();
  const rows = await dl.chains();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Ethereum");
  assert.equal(rows[0].chainId, 1);
  assert.equal(rows[0].tokenSymbol, "ETH");
  assert.equal(typeof rows[0].tvl, "number");
});

test("pools unwraps { data: [...] } into typed rows", async () => {
  const dl = fixtureClient();
  const rows = await dl.pools();
  assert.equal(rows.length, 2);
  const p0 = rows[0];
  assert.equal(p0.project, "aave-v3");
  assert.equal(p0.symbol, "USDC");
  assert.equal(p0.stablecoin, true);
  assert.equal(p0.apy, 3.66);
  assert.equal(rows[1].apyReward, null);
  assert.equal(rows[1].stablecoin, false);
});

test("base URLs are the documented read-only hosts", () => {
  assert.equal(DEFILLAMA_TVL_BASE, "https://api.llama.fi");
  assert.equal(DEFILLAMA_YIELDS_BASE, "https://yields.llama.fi");
});

test("malformed protocols payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  });
  const dl = new DefiLlamaClient({ tvlHttp: http });
  await assert.rejects(() => dl.protocols(), AdapterError);
});

test("pools without data array throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
  });
  const dl = new DefiLlamaClient({ yieldsHttp: http });
  await assert.rejects(() => dl.pools(), AdapterError);
});
