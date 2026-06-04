// ccmixter.test.mjs — offline tests for the ccMixter adapter (EE2-4).
import { test } from "node:test";
import assert from "node:assert/strict";

import { CcMixterClient, resolveCcmixterApiKey, CCMIXTER_BASE_URL } from "./ccmixter.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new CcMixterClient({ fixtureMode: true, ...opts });
}

test("base url points at ccmixter.org; api key optional from env", () => {
  assert.match(CCMIXTER_BASE_URL, /ccmixter\.org$/);
  assert.equal(resolveCcmixterApiKey({}), null);
  assert.equal(resolveCcmixterApiKey({ CCMIXTER_API_KEY: "k" }), "k");
});

test("search shapes uploads + surfaces license + remixOk", async () => {
  const cc = fixtureClient();
  const rows = await cc.search({ query: "sunrise" });
  assert.equal(rows.length, 2);
  const u = rows[0];
  assert.equal(u.source, "ccmixter");
  assert.equal(u.id, "60187");
  assert.equal(u.title, "Sunrise Remix");
  assert.equal(u.artist, "Bjorn Karlsson");
  assert.equal(u.durationSec, 248);
  assert.equal(u.audioUrl, "https://ccmixter.org/content/snowflake/snowflake_-_Sunrise_Remix.mp3");
  assert.equal(u.license.tier, "cc-by");
  // remix-culture flag surfaced
  assert.equal(u.attribution.remixOk, true);
  assert.equal(u.attribution.requiredCredit, true);
  // second is BY-NC
  assert.equal(rows[1].license.tier, "cc-by-nc");
  assert.equal(rows[1].attribution.commercialOk, false);
});

test("search requires a non-empty query", async () => {
  const cc = fixtureClient();
  await assert.rejects(() => cc.search({ query: "" }), AdapterError);
});

test("fetchById returns one shaped upload (BY-SA here)", async () => {
  const cc = fixtureClient();
  const u = await cc.fetchById("60187");
  assert.equal(u.id, "60187");
  assert.equal(u.license.tier, "cc-by-sa");
  assert.equal(u.attribution.shareAlike, true);
  assert.equal(u.attribution.remixOk, true);
});

test("non-array payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ oops: 1 }) }),
  });
  const cc = new CcMixterClient({ http });
  await assert.rejects(() => cc.search({ query: "x" }), AdapterError);
});
