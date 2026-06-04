// freesound.test.mjs — offline tests for the Freesound adapter (EE2-3).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FreesoundClient,
  resolveFreesoundToken,
  FREESOUND_BASE_URL,
  FREESOUND_FALLBACK_TOKEN,
} from "./freesound.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new FreesoundClient({ fixtureMode: true, ...opts });
}

test("base url points at apiv2; token falls back with env override", () => {
  assert.match(FREESOUND_BASE_URL, /freesound\.org\/apiv2$/);
  assert.equal(resolveFreesoundToken({}), FREESOUND_FALLBACK_TOKEN);
  assert.equal(resolveFreesoundToken({ FREESOUND_API_KEY: "tok" }), "tok");
});

test("token is sent as the Token Authorization header", () => {
  const fs = fixtureClient({ token: "abc" });
  assert.equal(fs.http.defaultHeaders.Authorization, "Token abc");
});

test("search returns count + typed results with license/attribution", async () => {
  const fs = fixtureClient();
  const out = await fs.search({ query: "temple" });
  assert.equal(out.count, 2);
  assert.equal(out.results.length, 2);
  const s = out.results[0];
  assert.equal(s.source, "freesound");
  assert.equal(s.id, "316847");
  assert.equal(s.author, "InspectorJ");
  assert.equal(s.previewUrl, "https://freesound.org/data/previews/316/316847-hq.mp3");
  assert.equal(s.license.tier, "cc-by");
  assert.equal(s.attribution.requiredCredit, true);
  assert.match(s.attribution.authorUrl, /people\/InspectorJ/);
  // second result is CC0
  assert.equal(out.results[1].license.tier, "public-domain");
  assert.equal(out.results[1].attribution.requiredCredit, false);
});

test("search requires a non-empty query", async () => {
  const fs = fixtureClient();
  await assert.rejects(() => fs.search({ query: "" }), AdapterError);
});

test("fetchById returns one shaped sound (BY-NC here)", async () => {
  const fs = fixtureClient();
  const s = await fs.fetchById("316847");
  assert.equal(s.id, "316847");
  assert.equal(s.license.tier, "cc-by-nc");
  assert.equal(s.attribution.commercialOk, false);
});

test("fetchById returns null on Freesound not-found shape", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ detail: "Not found." }) }),
  });
  const fs = new FreesoundClient({ http, token: "t" });
  assert.equal(await fs.fetchById("999"), null);
});

test("malformed search payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: "nope" }) }),
  });
  const fs = new FreesoundClient({ http, token: "t" });
  await assert.rejects(() => fs.search({ query: "x" }), AdapterError);
});
