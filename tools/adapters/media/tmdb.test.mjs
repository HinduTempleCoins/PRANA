// tmdb.test.mjs — offline tests for the TMDB adapter (EE2-7).
import { test } from "node:test";
import assert from "node:assert/strict";

import { TmdbClient, TMDB_BASE_URL, TMDB_IMAGE_BASE } from "./tmdb.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function fx(opts = {}) {
  return new TmdbClient({ fixtureMode: true, ...opts });
}

test("base + image hosts are the official TMDB endpoints", () => {
  assert.match(TMDB_BASE_URL, /api\.themoviedb\.org\/3$/);
  assert.match(TMDB_IMAGE_BASE, /image\.tmdb\.org\/t\/p$/);
});

test("searchMulti shapes movie + tv rows", async () => {
  const out = await fx().searchMulti({ query: "inception" });
  assert.equal(out.page, 1);
  assert.equal(out.results.length, 2);
  const movie = out.results[0];
  assert.equal(movie.mediaType, "movie");
  assert.equal(movie.title, "Inception");
  assert.equal(movie.voteAverage, 8.4);
  const tv = out.results[1];
  assert.equal(tv.mediaType, "tv");
  assert.equal(tv.title, "Breaking Bad");
  assert.equal(tv.releaseDate, "2008-01-20");
});

test("movie() pulls runtime, genres, imdbId", async () => {
  const m = await fx().movie(27205);
  assert.equal(m.mediaType, "movie");
  assert.equal(m.runtime, 148);
  assert.deepEqual(m.genres, ["Action", "Science Fiction"]);
  assert.equal(m.imdbId, "tt1375666");
});

test("tv() pulls season/episode counts", async () => {
  const t = await fx().tv(1396);
  assert.equal(t.mediaType, "tv");
  assert.equal(t.numberOfSeasons, 5);
  assert.equal(t.numberOfEpisodes, 62);
});

test("trending() returns shaped rows", async () => {
  const rows = await fx().trending({ mediaType: "movie", window: "week" });
  assert.equal(rows[0].mediaType, "movie");
  assert.equal(rows[0].title, "Trending Title");
});

test("query / id required", async () => {
  await assert.rejects(() => fx().searchMulti({ query: "" }), AdapterError);
  await assert.rejects(() => fx().movie(""), AdapterError);
});

test("v4 read token → Authorization bearer; v3 key → api_key param", () => {
  const withTok = fx({ readToken: "v4tok" });
  assert.equal(withTok.http.defaultHeaders.Authorization, "Bearer v4tok");
  // With a token we do NOT append api_key.
  const p = withTok._params({ x: "1" });
  assert.equal(p.get("api_key"), null);

  const withKey = fx({ apiKey: "v3key" });
  assert.equal(withKey._params().get("api_key"), "v3key");
});

test("imageUrl builds the CDN url, null-safe", () => {
  const c = fx();
  assert.equal(c.imageUrl("/poster.jpg"), `${TMDB_IMAGE_BASE}/w500/poster.jpg`);
  assert.equal(c.imageUrl(null), null);
});

test("non-array search payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: "nope" }) }),
  });
  const c = new TmdbClient({ http, apiKey: "k" });
  await assert.rejects(() => c.searchMulti({ query: "x" }), AdapterError);
});
