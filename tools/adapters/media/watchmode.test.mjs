// watchmode.test.mjs — offline tests for the Watchmode adapter (EE2-8).
import { test } from "node:test";
import assert from "node:assert/strict";

import { WatchmodeClient, WATCHMODE_BASE_URL } from "./watchmode.mjs";
import { HttpClient, AdapterError, RateLimitError } from "../base.mjs";

function fx(opts = {}) {
  return new WatchmodeClient({ fixtureMode: true, ...opts });
}

test("base url is the official Watchmode API", () => {
  assert.match(WATCHMODE_BASE_URL, /api\.watchmode\.com$/);
});

test("search shapes title results", async () => {
  const rows = await fx().search({ query: "inception" });
  assert.equal(rows[0].id, 1396171);
  assert.equal(rows[0].name, "Inception");
  assert.equal(rows[0].imdbId, "tt1375666");
  assert.equal(rows[0].tmdbId, 27205);
});

test("sources lists where-to-watch with offer type", async () => {
  const rows = await fx().sources(1396171);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "Netflix");
  assert.equal(rows[0].type, "sub");
  const free = rows.find((r) => r.type === "free");
  assert.equal(free.name, "Tubi");
  const rent = rows.find((r) => r.type === "rent");
  assert.equal(rent.price, 3.99);
});

test("details shapes overview + genres", async () => {
  const d = await fx().details(1396171);
  assert.equal(d.title, "Inception");
  assert.equal(d.runtimeMinutes, 148);
  assert.deepEqual(d.genreNames, ["Action", "Science Fiction", "Adventure"]);
});

test("query / id required", async () => {
  await assert.rejects(() => fx().search({ query: "" }), AdapterError);
  await assert.rejects(() => fx().sources(""), AdapterError);
});

test("apiKey appended as the apiKey query param", () => {
  const c = fx({ apiKey: "WM-1" });
  assert.equal(c._params().get("apiKey"), "WM-1");
});

test("non-array sources payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "array" }) }),
  });
  const c = new WatchmodeClient({ http, apiKey: "k" });
  await assert.rejects(() => c.sources(1), AdapterError);
});

test("upstream 429 surfaces as RateLimitError", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "rl" }),
  });
  const c = new WatchmodeClient({ http, apiKey: "k" });
  await assert.rejects(() => c.search({ query: "x" }), RateLimitError);
});
