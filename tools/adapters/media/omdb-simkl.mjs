// omdb-simkl.mjs — OMDb + Simkl supplementary film/TV metadata (EE2-10).
//
// Two supplementary metadata sources that backfill the TMDB spine (Doc §8
// Film/TV metadata: TMDB · Watchmode · Trakt · **OMDb · Simkl**):
//   - OMDb  — IMDb-derived ratings/plot by IMDb id or title. Free key, query
//             param `apikey`. The "give me the IMDb rating + Rotten Tomatoes
//             score" backfill.
//   - Simkl — TV/anime-leaning tracking DB; id cross-walk + summaries. Free
//             API key sent as `client_id` query param (read-only public
//             endpoints).
// Keys from env: OMDB_API_KEY, SIMKL_CLIENT_ID.
//
// Both clients share the base layer (rate-limit/retry/cache/typed-errors/
// fixture-mode). Each is a small typed client; they live in one module because
// the queue groups them (EE2-10) and they play the same supplementary role.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const OMDB_BASE_URL = "https://www.omdbapi.com";
export const SIMKL_BASE_URL = "https://api.simkl.com";

// --------------------------------------------------------------------------
// OMDb
// --------------------------------------------------------------------------
export class OmdbClient {
  constructor({
    baseUrl = OMDB_BASE_URL,
    apiKey = process.env.OMDB_API_KEY ?? null,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 3_600_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: () => "omdb-title",
        ...httpOpts,
      });
  }

  _params(extra = {}) {
    const p = new URLSearchParams(extra);
    if (this.apiKey) p.set("apikey", this.apiKey);
    return p;
  }

  // Lookup by IMDb id (i=tt...) or by title (t=...). One of imdbId/title required.
  async title({ imdbId = null, title = null, type = null, year = null } = {}) {
    const extra = {};
    if (imdbId) extra.i = String(imdbId);
    else if (title) extra.t = String(title);
    else throw new AdapterError("omdb: imdbId or title is required");
    if (type) extra.type = String(type);
    if (year) extra.y = String(year);
    const raw = await this.http.getJson(`/?${this._params(extra).toString()}`, { fixture: "omdb-title" });
    return shapeOmdb(raw);
  }

  // Free-text search: GET /?s=...
  async search({ query, type = null, page = 1 } = {}) {
    const q = query == null ? "" : String(query).trim();
    if (!q) throw new AdapterError("omdb: query is required");
    const extra = { s: q, page: String(page) };
    if (type) extra.type = String(type);
    const raw = await this.http.getJson(`/?${this._params(extra).toString()}`, { fixture: "omdb-search" });
    if (raw?.Response === "False") {
      throw new AdapterError(`omdb search: ${raw.Error ?? "no results"}`, { details: { query: q } });
    }
    const rows = raw?.Search;
    if (!Array.isArray(rows)) {
      throw new AdapterError("omdb search: expected Search array", { details: { got: typeof rows } });
    }
    return rows.map(shapeOmdbSearchRow);
  }
}

// --------------------------------------------------------------------------
// Simkl
// --------------------------------------------------------------------------
export class SimklClient {
  constructor({
    baseUrl = SIMKL_BASE_URL,
    clientId = process.env.SIMKL_CLIENT_ID ?? null,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 600_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.clientId = clientId;
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => simklFixtureName(url),
        ...httpOpts,
      });
  }

  _params(extra = {}) {
    const p = new URLSearchParams(extra);
    if (this.clientId) p.set("client_id", this.clientId);
    return p;
  }

  // GET /search/{type}?q=...  (type: movie | tv | anime)
  async search({ query, type = "movie" } = {}) {
    const q = query == null ? "" : String(query).trim();
    if (!q) throw new AdapterError("simkl: query is required");
    const t = ["movie", "tv", "anime"].includes(type) ? type : "movie";
    const raw = await this.http.getJson(`/search/${t}?${this._params({ q }).toString()}`, {
      fixture: "simkl-search",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("simkl search: expected array", { details: { got: typeof raw } });
    }
    return raw.map(shapeSimklRow);
  }

  // GET /search/id?imdb=tt...  — id cross-walk lookup.
  async byId({ imdb = null, tmdb = null, simkl = null } = {}) {
    const extra = {};
    if (imdb) extra.imdb = String(imdb);
    else if (tmdb) extra.tmdb = String(tmdb);
    else if (simkl) extra.simkl = String(simkl);
    else throw new AdapterError("simkl: one of imdb/tmdb/simkl is required");
    const raw = await this.http.getJson(`/search/id?${this._params(extra).toString()}`, {
      fixture: "simkl-by-id",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("simkl byId: expected array", { details: { got: typeof raw } });
    }
    return raw.map(shapeSimklRow);
  }
}

// ---- shaping helpers ----------------------------------------------------

function shapeOmdb(r) {
  if (r == null || typeof r !== "object") {
    throw new AdapterError("omdb: unexpected payload", { details: { got: typeof r } });
  }
  if (r.Response === "False") {
    throw new AdapterError(`omdb: ${r.Error ?? "not found"}`);
  }
  const ratings = {};
  if (Array.isArray(r.Ratings)) {
    for (const rt of r.Ratings) {
      if (rt?.Source) ratings[rt.Source] = rt.Value ?? null;
    }
  }
  return {
    imdbId: nz(r.imdbID),
    title: nz(r.Title),
    type: nz(r.Type),
    year: nz(r.Year),
    rated: nz(r.Rated),
    runtime: nz(r.Runtime),
    genre: nz(r.Genre),
    plot: nz(r.Plot),
    poster: nz(r.Poster),
    imdbRating: r.imdbRating && r.imdbRating !== "N/A" ? Number(r.imdbRating) : null,
    imdbVotes: nz(r.imdbVotes),
    metascore: r.Metascore && r.Metascore !== "N/A" ? Number(r.Metascore) : null,
    ratings,
  };
}
function shapeOmdbSearchRow(r) {
  return {
    imdbId: nz(r.imdbID),
    title: nz(r.Title),
    year: nz(r.Year),
    type: nz(r.Type),
    poster: nz(r.Poster),
  };
}
function shapeSimklRow(r) {
  const ids = r.ids ?? {};
  return {
    title: r.title ?? null,
    year: r.year ?? null,
    type: r.type ?? null,
    poster: r.poster ?? null,
    ids: {
      simkl: ids.simkl ?? ids.simkl_id ?? null,
      imdb: ids.imdb ?? null,
      tmdb: ids.tmdb ?? null,
      slug: ids.slug ?? null,
    },
  };
}

// OMDb uses the literal string "N/A" for missing fields — normalise to null.
function nz(v) {
  return v == null || v === "N/A" ? null : v;
}

function simklFixtureName(url) {
  if (url.includes("/search/id")) return "simkl-by-id";
  if (url.includes("/search/")) return "simkl-search";
  return null;
}
