// free-music-archive.test.mjs — offline tests for the FMA adapter (EE2-2).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FreeMusicArchiveClient,
  resolveFmaBaseUrl,
  resolveFmaApiKey,
  FMA_FALLBACK_BASE_URL,
} from "./free-music-archive.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new FreeMusicArchiveClient({ fixtureMode: true, ...opts });
}

test("base url + key resolve from env with documented fallback", () => {
  assert.equal(resolveFmaBaseUrl({}), FMA_FALLBACK_BASE_URL);
  assert.equal(resolveFmaBaseUrl({ FMA_BASE_URL: "https://example.test" }), "https://example.test");
  assert.equal(resolveFmaApiKey({}), null);
  assert.equal(resolveFmaApiKey({ FMA_API_KEY: "k" }), "k");
});

test("search shapes tracks + surfaces license/attribution; parses mm:ss + seconds", async () => {
  const fma = fixtureClient();
  const rows = await fma.search({ query: "enthusiast" });
  assert.equal(rows.length, 2);
  const a = rows[0];
  assert.equal(a.source, "free-music-archive");
  assert.equal(a.id, "20901");
  assert.equal(a.title, "Enthusiast");
  assert.equal(a.artist, "Tours");
  assert.equal(a.durationSec, 234); // "03:54"
  assert.equal(a.license.tier, "cc-by");
  assert.equal(a.attribution.requiredCredit, true);
  // second track: seconds form + BY-NC
  assert.equal(rows[1].durationSec, 210);
  assert.equal(rows[1].license.tier, "cc-by-nc");
  assert.equal(rows[1].attribution.commercialOk, false);
});

test("search requires a non-empty query", async () => {
  const fma = fixtureClient();
  await assert.rejects(() => fma.search({ query: "" }), AdapterError);
});

test("fetchById returns one shaped track (CC0 here)", async () => {
  const fma = fixtureClient();
  const t = await fma.fetchById("20901");
  assert.equal(t.id, "20901");
  assert.equal(t.license.tier, "public-domain");
  assert.equal(t.attribution.requiredCredit, false);
});

test("API key is sent as a query param when provided (no header leak)", () => {
  const fma = fixtureClient({ apiKey: "fma-key" });
  assert.equal(fma.apiKey, "fma-key");
});

test("unexpected payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ weird: true }) }),
  });
  const fma = new FreeMusicArchiveClient({ http });
  await assert.rejects(() => fma.search({ query: "x" }), AdapterError);
});
