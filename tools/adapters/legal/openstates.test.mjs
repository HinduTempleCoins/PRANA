// openstates.test.mjs — offline tests for the Open States adapter (BB2-8).
import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenStatesClient, OPENSTATES_BASE_URL, OPENSTATES_API_KEY_ENV } from "./openstates.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new OpenStatesClient({ fixtureMode: true, ...opts });
}

test("searchBills shapes typed state bills + pagination", async () => {
  const os = fixtureClient();
  const out = await os.searchBills({ jurisdiction: "Texas", query: "public records" });
  assert.equal(out.results.length, 2);
  const b = out.results[0];
  assert.equal(b.identifier, "HB 1");
  assert.equal(b.jurisdiction, "Texas");
  assert.equal(b.session, "88");
  assert.deepEqual(b.subject, ["Public Records", "Government Operations"]);
  assert.equal(b.sponsors[0].primary, true);
  assert.equal(out.pagination.totalItems, 2);
});

test("searchBills requires jurisdiction or query", async () => {
  const os = fixtureClient();
  await assert.rejects(() => os.searchBills({}), AdapterError);
});

test("fetchBillById shapes one bill", async () => {
  const os = fixtureClient();
  const b = await os.fetchBillById("ocd-bill/aaaa-1111-2222-3333");
  assert.equal(b.identifier, "HB 1");
  assert.equal(b.sponsors.length, 2);
  assert.match(b.openstatesUrl, /openstates\.org/);
});

test("fetchBillById requires an id", async () => {
  const os = fixtureClient();
  await assert.rejects(() => os.fetchBillById(), AdapterError);
});

test("searchLegislators shapes typed people", async () => {
  const os = fixtureClient();
  const out = await os.searchLegislators({ jurisdiction: "Texas" });
  assert.equal(out.results.length, 2);
  const p = out.results[0];
  assert.equal(p.name, "Jane Q. Public");
  assert.equal(p.party, "Democratic");
  assert.equal(p.currentRole.district, "100");
});

test("fetchLegislatorById shapes one person", async () => {
  const os = fixtureClient();
  const p = await os.fetchLegislatorById("ocd-person/1111-aaaa-2222-bbbb");
  assert.equal(p.name, "Jane Q. Public");
  assert.equal(p.currentRole.org, "lower");
});

test("API key is sent as the X-API-KEY header when provided", () => {
  const os = new OpenStatesClient({ fixtureMode: true, apiKey: "os-test-123" });
  assert.equal(os.http.defaultHeaders["X-API-KEY"], "os-test-123");
});

test("base url default points at the v3 API", () => {
  assert.match(OPENSTATES_BASE_URL, /v3\.openstates\.org$/);
});

test("documented fallback: missing key + no fixtureMode throws actionable AdapterError", async () => {
  const prev = process.env[OPENSTATES_API_KEY_ENV];
  delete process.env[OPENSTATES_API_KEY_ENV];
  try {
    const os = new OpenStatesClient({}); // no key, no fixtureMode
    await assert.rejects(
      () => os.searchBills({ jurisdiction: "Texas" }),
      (e) => {
        assert.equal(e.name, "AdapterError");
        assert.match(e.message, new RegExp(OPENSTATES_API_KEY_ENV));
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env[OPENSTATES_API_KEY_ENV] = prev;
  }
});

// error mapping through an injected HttpClient (simulate a 429)
test("upstream 429 surfaces as RateLimitError", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "rl" }),
  });
  const os = new OpenStatesClient({ http, apiKey: "k" });
  await assert.rejects(() => os.searchBills({ jurisdiction: "Texas" }), (e) => {
    assert.equal(e.name, "RateLimitError");
    return true;
  });
});
