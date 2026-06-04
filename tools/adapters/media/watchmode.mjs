// watchmode.mjs — Watchmode "where-to-watch" availability adapter (EE2-8).
//
// The availability arm of the discovery spine (Doc §3b: TMDB metadata +
// **Watchmode where-to-watch** + Trakt). Given a title, Watchmode returns the
// streaming sources (Netflix/Prime/Tubi/Pluto/...) and the type of offer
// (subscription / free / rent / buy) per region — exactly the JustWatch model.
//
// Free tier: a free API key sent as the `apiKey` query param. From env:
//   WATCHMODE_API_KEY
//
// Wired through the shared base layer: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. Endpoints covered:
//   GET /v1/search/            — title search (search_field=name)
//   GET /v1/title/{id}/sources/ — streaming sources for a title
//   GET /v1/title/{id}/details/ — title details

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const WATCHMODE_BASE_URL = "https://api.watchmode.com";

export class WatchmodeClient {
  constructor({
    baseUrl = WATCHMODE_BASE_URL,
    apiKey = process.env.WATCHMODE_API_KEY ?? null,
    fixtureMode = false,
    // Free tier is 1000 req/month — be very conservative.
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 0.5 }),
    cache = new TTLCache({ ttlMs: 3_600_000 }), // 1h — availability changes slowly
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
        fixtureResolver: (url) => watchmodeFixtureName(url),
        ...httpOpts,
      });
  }

  _params(extra = {}) {
    const p = new URLSearchParams(extra);
    if (this.apiKey) p.set("apiKey", this.apiKey);
    return p;
  }

  // GET /v1/search/?search_field=name&search_value=...
  async search({ query, types = null } = {}) {
    const q = reqQuery(query);
    const extra = { search_field: "name", search_value: q };
    if (types) extra.types = Array.isArray(types) ? types.join(",") : String(types);
    const raw = await this.http.getJson(`/v1/search/?${this._params(extra).toString()}`, {
      fixture: "watchmode-search",
    });
    const rows = raw?.title_results;
    if (!Array.isArray(rows)) {
      throw new AdapterError("watchmode search: expected title_results array", {
        details: { got: typeof rows },
      });
    }
    return rows.map(shapeSearchRow);
  }

  // GET /v1/title/{id}/sources/  — the where-to-watch list.
  async sources(id, { regions = null } = {}) {
    const extra = {};
    if (regions) extra.regions = Array.isArray(regions) ? regions.join(",") : String(regions);
    const raw = await this.http.getJson(
      `/v1/title/${reqId(id)}/sources/?${this._params(extra).toString()}`,
      { fixture: "watchmode-sources" },
    );
    if (!Array.isArray(raw)) {
      throw new AdapterError("watchmode sources: expected array payload", { details: { got: typeof raw } });
    }
    return raw.map(shapeSource);
  }

  // GET /v1/title/{id}/details/
  async details(id) {
    const raw = await this.http.getJson(
      `/v1/title/${reqId(id)}/details/?${this._params().toString()}`,
      { fixture: "watchmode-details" },
    );
    return shapeDetails(raw);
  }
}

// ---- shaping helpers ----------------------------------------------------

function reqQuery(query) {
  const q = query == null ? "" : String(query).trim();
  if (!q) throw new AdapterError("query is required");
  return q;
}
function reqId(id) {
  if (id == null || String(id).trim() === "") throw new AdapterError("id is required");
  return encodeURIComponent(String(id));
}

function shapeSearchRow(r) {
  return {
    id: r.id,
    name: r.name ?? null,
    type: r.type ?? null,
    year: r.year ?? null,
    imdbId: r.imdb_id ?? null,
    tmdbId: r.tmdb_id ?? null,
  };
}

function shapeSource(s) {
  return {
    sourceId: s.source_id,
    name: s.name ?? null,
    // type: sub | free | rent | buy | tve  (the offer kind)
    type: s.type ?? null,
    region: s.region ?? null,
    webUrl: s.web_url ?? null,
    format: s.format ?? null,
    price: s.price != null ? Number(s.price) : null,
    seasons: s.seasons ?? null,
    episodes: s.episodes ?? null,
  };
}

function shapeDetails(r) {
  if (r == null || typeof r !== "object") {
    throw new AdapterError("watchmode details: unexpected payload", { details: { got: typeof r } });
  }
  return {
    id: r.id,
    title: r.title ?? null,
    type: r.type ?? null,
    year: r.year ?? null,
    imdbId: r.imdb_id ?? null,
    tmdbId: r.tmdb_id ?? null,
    plotOverview: r.plot_overview ?? null,
    userRating: r.user_rating != null ? Number(r.user_rating) : null,
    runtimeMinutes: r.runtime_minutes ?? null,
    genreNames: Array.isArray(r.genre_names) ? r.genre_names : [],
  };
}

function watchmodeFixtureName(url) {
  if (url.includes("/search/")) return "watchmode-search";
  if (url.includes("/sources/")) return "watchmode-sources";
  if (url.includes("/details/")) return "watchmode-details";
  return null;
}
