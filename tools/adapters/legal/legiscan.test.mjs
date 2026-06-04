// legiscan.test.mjs — offline tests for the LegiScan adapter (BB2-9).
import { test } from "node:test";
import assert from "node:assert/strict";

import { LegiScanClient, LEGISCAN_BASE_URL, LEGISCAN_API_KEY_ENV } from "./legiscan.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new LegiScanClient({ fixtureMode: true, ...opts });
}

test("searchBills unwraps + shapes typed hits + summary", async () => {
  const ls = fixtureClient();
  const out = await ls.searchBills({ state: "TX", query: "public records" });
  assert.equal(out.results.length, 2);
  const h = out.results[0];
  assert.equal(h.billId, 1700001);
  assert.equal(h.billNumber, "HB1");
  assert.equal(h.state, "TX");
  assert.equal(h.relevance, 95);
  assert.equal(out.summary.count, 2);
});

test("searchBills requires a query", async () => {
  const ls = fixtureClient();
  await assert.rejects(() => ls.searchBills({ state: "TX" }), AdapterError);
});

test("fetchBillById unwraps + shapes one bill", async () => {
  const ls = fixtureClient();
  const b = await ls.fetchBillById(1700001);
  assert.equal(b.billId, 1700001);
  assert.equal(b.billNumber, "HB1");
  assert.equal(b.state, "TX");
  assert.equal(b.session.year, 2024);
  assert.equal(b.sponsors.length, 2);
  assert.deepEqual(b.subjects, ["Public Records", "Government Operations"]);
  assert.equal(b.history.length, 2);
  assert.equal(b.texts[0].docId, 555);
});

test("fetchBillById requires a billId", async () => {
  const ls = fixtureClient();
  await assert.rejects(() => ls.fetchBillById(), AdapterError);
});

test("ERROR status maps to a typed AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ERROR", alert: { message: "Invalid API Key token" } }),
    }),
  });
  const ls = new LegiScanClient({ http, apiKey: "k" });
  await assert.rejects(() => ls.fetchBillById(1), (e) => {
    assert.equal(e.name, "AdapterError");
    assert.match(e.message, /Invalid API Key token/);
    return true;
  });
});

test("base url default points at the LegiScan API", () => {
  assert.match(LEGISCAN_BASE_URL, /api\.legiscan\.com$/);
});

test("documented fallback: missing key + no fixtureMode throws actionable AdapterError", async () => {
  const prev = process.env[LEGISCAN_API_KEY_ENV];
  delete process.env[LEGISCAN_API_KEY_ENV];
  try {
    const ls = new LegiScanClient({});
    await assert.rejects(
      () => ls.searchBills({ query: "x" }),
      (e) => {
        assert.equal(e.name, "AdapterError");
        assert.match(e.message, new RegExp(LEGISCAN_API_KEY_ENV));
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env[LEGISCAN_API_KEY_ENV] = prev;
  }
});

test("upstream 429 surfaces as RateLimitError", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "rl" }),
  });
  const ls = new LegiScanClient({ http, apiKey: "k" });
  await assert.rejects(() => ls.searchBills({ query: "x" }), (e) => {
    assert.equal(e.name, "RateLimitError");
    return true;
  });
});
