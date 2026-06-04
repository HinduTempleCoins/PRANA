// trakt.test.mjs — offline tests for the Trakt adapter (EE2-9).
import { test } from "node:test";
import assert from "node:assert/strict";

import { TraktClient, TRAKT_BASE_URL } from "./trakt.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fx(opts = {}) {
  return new TraktClient({ fixtureMode: true, clientId: "cid", ...opts });
}

test("base url is the official Trakt API", () => {
  assert.match(TRAKT_BASE_URL, /api\.trakt\.tv$/);
});

test("required auth headers are set", () => {
  const c = fx({ clientId: "abc", accessToken: "tok" });
  assert.equal(c.http.defaultHeaders["trakt-api-key"], "abc");
  assert.equal(c.http.defaultHeaders["trakt-api-version"], "2");
  assert.equal(c.http.defaultHeaders.Authorization, "Bearer tok");
});

test("trendingMovies unwraps .movie + keeps watchers", async () => {
  const rows = await fx().trendingMovies({ limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].watchers, 142);
  assert.equal(rows[0].title, "Inception");
  assert.equal(rows[0].ids.imdb, "tt1375666");
  assert.equal(rows[0].type, "movie");
});

test("popularShows shapes show rows", async () => {
  const rows = await fx().popularShows();
  assert.equal(rows[0].type, "show");
  assert.equal(rows[0].title, "Breaking Bad");
  assert.equal(rows[0].ids.tmdb, 1396);
});

test("userHistory shapes movie + episode rows", async () => {
  const rows = await fx().userHistory("me");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "watch");
  assert.equal(rows[0].item.title, "Inception");
  assert.equal(rows[1].episode.season, 1);
  assert.equal(rows[1].episode.title, "Pilot");
  assert.equal(rows[1].item.type, "show");
});

test("userLists shapes lists", async () => {
  const rows = await fx().userLists("me");
  assert.equal(rows[0].name, "Watchlist 2026");
  assert.equal(rows[0].itemCount, 42);
  assert.equal(rows[0].privacy, "public");
});

test("userId required", async () => {
  await assert.rejects(() => fx().userHistory(""), AdapterError);
  await assert.rejects(() => fx().userLists(null), AdapterError);
});

test("non-array trending payload throws AdapterError", async () => {
  const http = new HttpClient({
    defaultHeaders: { "trakt-api-key": "x" },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "array" }) }),
  });
  const c = new TraktClient({ http });
  await assert.rejects(() => c.trendingMovies(), AdapterError);
});
