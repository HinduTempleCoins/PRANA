// congress-gov.test.mjs — offline tests for the Congress.gov adapter (BB2-10).
import { test } from "node:test";
import assert from "node:assert/strict";

import { CongressGovClient, CONGRESS_GOV_BASE_URL, CONGRESS_GOV_API_KEY_ENV } from "./congress-gov.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new CongressGovClient({ fixtureMode: true, ...opts });
}

test("searchBills shapes typed federal bills + pagination", async () => {
  const cg = fixtureClient();
  const out = await cg.searchBills({ congress: 118, query: "transparency" });
  assert.equal(out.results.length, 2);
  const b = out.results[0];
  assert.equal(b.type, "HR");
  assert.equal(b.number, "3076");
  assert.equal(b.latestAction.text, "Became Public Law No: 117-108.");
  assert.equal(out.pagination.count, 2);
});

test("fetchBillById shapes one bill with sponsors + counts", async () => {
  const cg = fixtureClient();
  const b = await cg.fetchBillById({ congress: 117, billType: "HR", number: 3076 });
  assert.equal(b.title, "Postal Service Reform Act of 2022");
  assert.equal(b.introducedDate, "2021-05-11");
  assert.equal(b.sponsors[0].bioguideId, "M000087");
  assert.equal(b.cosponsorCount, 102);
});

test("fetchBillById requires congress, billType, number", async () => {
  const cg = fixtureClient();
  await assert.rejects(() => cg.fetchBillById({ congress: 117 }), AdapterError);
});

test("searchMembers shapes typed members", async () => {
  const cg = fixtureClient();
  const out = await cg.searchMembers({ congress: 118 });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].bioguideId, "M000087");
  assert.equal(out.results[1].chamber, "Senate");
});

test("fetchMemberById shapes one member", async () => {
  const cg = fixtureClient();
  const m = await cg.fetchMemberById("C001098");
  assert.equal(m.bioguideId, "C001098");
  assert.equal(m.name, "Ted Cruz");
  assert.equal(m.party, "Republican");
});

test("searchNominations + fetchNominationById shape nominations", async () => {
  const cg = fixtureClient();
  const list = await cg.searchNominations({ congress: 118 });
  assert.equal(list.results.length, 1);
  assert.equal(list.results[0].citation, "PN1234");

  const one = await cg.fetchNominationById({ congress: 118, number: 1234 });
  assert.equal(one.organization, "Department of Justice");
  assert.equal(one.latestAction.text, "Confirmed by the Senate by Voice Vote.");
});

test("fetchNominationById requires congress + number", async () => {
  const cg = fixtureClient();
  await assert.rejects(() => cg.fetchNominationById({ congress: 118 }), AdapterError);
});

test("Accept: application/json header is set", () => {
  const cg = fixtureClient();
  assert.equal(cg.http.defaultHeaders["Accept"], "application/json");
});

test("base url default points at the v3 API", () => {
  assert.match(CONGRESS_GOV_BASE_URL, /api\.congress\.gov\/v3$/);
});

test("documented fallback: missing key + no fixtureMode throws actionable AdapterError", async () => {
  const prev = process.env[CONGRESS_GOV_API_KEY_ENV];
  delete process.env[CONGRESS_GOV_API_KEY_ENV];
  try {
    const cg = new CongressGovClient({});
    await assert.rejects(
      () => cg.searchBills({ congress: 118 }),
      (e) => {
        assert.equal(e.name, "AdapterError");
        assert.match(e.message, new RegExp(CONGRESS_GOV_API_KEY_ENV));
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env[CONGRESS_GOV_API_KEY_ENV] = prev;
  }
});

test("upstream 429 surfaces as RateLimitError", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "rl" }),
  });
  const cg = new CongressGovClient({ http, apiKey: "k" });
  await assert.rejects(() => cg.searchBills({ congress: 118 }), (e) => {
    assert.equal(e.name, "RateLimitError");
    return true;
  });
});
