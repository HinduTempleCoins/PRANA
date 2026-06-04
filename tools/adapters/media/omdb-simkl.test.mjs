// omdb-simkl.test.mjs — offline tests for OMDb + Simkl adapters (EE2-10).
import { test } from "node:test";
import assert from "node:assert/strict";

import { OmdbClient, SimklClient, OMDB_BASE_URL, SIMKL_BASE_URL } from "./omdb-simkl.mjs";
import { HttpClient, AdapterError } from "../base.mjs";

function omdb(opts = {}) {
  return new OmdbClient({ fixtureMode: true, apiKey: "k", ...opts });
}
function simkl(opts = {}) {
  return new SimklClient({ fixtureMode: true, clientId: "cid", ...opts });
}

test("base urls are the official endpoints", () => {
  assert.match(OMDB_BASE_URL, /omdbapi\.com$/);
  assert.match(SIMKL_BASE_URL, /api\.simkl\.com$/);
});

test("omdb.title shapes ratings map + numeric imdbRating", async () => {
  const m = await omdb().title({ imdbId: "tt1375666" });
  assert.equal(m.title, "Inception");
  assert.equal(m.imdbRating, 8.8);
  assert.equal(m.metascore, 74);
  assert.equal(m.ratings["Rotten Tomatoes"], "87%");
});

test("omdb 'N/A' fields normalise to null", async () => {
  const rows = await omdb().search({ query: "inception" });
  const naPoster = rows.find((r) => r.imdbId === "tt1790736");
  assert.equal(naPoster.poster, null);
});

test("omdb.title requires imdbId or title", async () => {
  await assert.rejects(() => omdb().title({}), AdapterError);
});

test("omdb 'Response: False' on title throws", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Response: "False", Error: "Movie not found!" }) }),
  });
  const c = new OmdbClient({ http, apiKey: "k" });
  await assert.rejects(() => c.title({ imdbId: "tt000" }), AdapterError);
});

test("simkl.search shapes anime row + ids", async () => {
  const rows = await simkl().search({ query: "attack on titan", type: "anime" });
  assert.equal(rows[0].title, "Attack on Titan");
  assert.equal(rows[0].type, "anime");
  assert.equal(rows[0].ids.imdb, "tt2560140");
});

test("simkl.byId cross-walks an imdb id", async () => {
  const rows = await simkl().byId({ imdb: "tt1375666" });
  assert.equal(rows[0].ids.tmdb, 27205);
  assert.equal(rows[0].title, "Inception");
});

test("simkl byId requires one id", async () => {
  await assert.rejects(() => simkl().byId({}), AdapterError);
});

test("simkl clientId appended as client_id param", () => {
  const c = simkl({ clientId: "SK-1" });
  assert.equal(c._params().get("client_id"), "SK-1");
});
