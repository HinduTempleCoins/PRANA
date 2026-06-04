// musopen.test.mjs — offline tests for the Musopen adapter (EE2-5).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MusopenClient,
  resolveMusopenBaseUrl,
  resolveMusopenApiKey,
  MUSOPEN_FALLBACK_BASE_URL,
} from "./musopen.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new MusopenClient({ fixtureMode: true, ...opts });
}

test("base url + key resolve from env with documented fallback", () => {
  assert.equal(resolveMusopenBaseUrl({}), MUSOPEN_FALLBACK_BASE_URL);
  assert.equal(resolveMusopenBaseUrl({ MUSOPEN_BASE_URL: "https://x.test" }), "https://x.test");
  assert.equal(resolveMusopenApiKey({}), null);
  assert.equal(resolveMusopenApiKey({ MUSOPEN_API_KEY: "k" }), "k");
});

test("token sent as Authorization header when provided", () => {
  const m = fixtureClient({ apiKey: "tok" });
  assert.equal(m.http.defaultHeaders.Authorization, "Token tok");
});

test("recordings search tiers PD and CC; surfaces composer/performer", async () => {
  const m = fixtureClient();
  const out = await m.search({ query: "beethoven" });
  assert.equal(out.count, 2);
  const pd = out.results[0];
  assert.equal(pd.source, "musopen");
  assert.equal(pd.kind, "recording");
  assert.equal(pd.composer, "Ludwig van Beethoven");
  assert.deepEqual(pd.performers, ["Fulda Symphonic Orchestra"]);
  assert.equal(pd.license.tier, "public-domain");
  assert.equal(pd.attribution.requiredCredit, false);
  assert.equal(pd.attribution.courtesyCredit, true);
  // second recording is CC-BY
  assert.equal(out.results[1].license.tier, "cc-by");
  assert.equal(out.results[1].attribution.requiredCredit, true);
});

test("recording fetchById returns one shaped PD recording", async () => {
  const m = fixtureClient();
  const r = await m.fetchById("50271");
  assert.equal(r.id, "50271");
  assert.equal(r.kind, "recording");
  assert.equal(r.license.tier, "public-domain");
  assert.match(r.pageUrl, /symphony-no-5/);
});

test("sheet-music search + fetch shape PD sheets", async () => {
  const m = fixtureClient();
  const list = await m.searchSheetMusic({ query: "moonlight" });
  assert.equal(list.results.length, 1);
  const s = list.results[0];
  assert.equal(s.kind, "sheet-music");
  assert.equal(s.composer, "Ludwig van Beethoven");
  assert.equal(s.pages, 21);
  assert.match(s.pdfUrl, /\.pdf$/);
  assert.equal(s.license.tier, "public-domain");

  const one = await m.fetchSheetMusicById("7711");
  assert.equal(one.id, "7711");
  assert.equal(one.kind, "sheet-music");
});

test("queries are required across both asset kinds", async () => {
  const m = fixtureClient();
  await assert.rejects(() => m.search({ query: "" }), AdapterError);
  await assert.rejects(() => m.searchSheetMusic({ query: "" }), AdapterError);
  await assert.rejects(() => m.fetchById(""), AdapterError);
  await assert.rejects(() => m.fetchSheetMusicById(""), AdapterError);
});

test("recording fetchById returns null on not-found shape", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ detail: "Not found." }) }),
  });
  const m = new MusopenClient({ http });
  assert.equal(await m.fetchById("999"), null);
});

test("license classifier defaults absent license to assumed-PD", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: 1, title: "x", composer: "Anon" }] }),
    }),
  });
  const m = new MusopenClient({ http });
  const out = await m.search({ query: "x" });
  assert.equal(out.results[0].license.tier, "public-domain");
  assert.equal(out.results[0].license.assumed, true);
});
