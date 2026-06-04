// tmdb.mjs — TMDB film/TV metadata adapter (EE2-7).
//
// The discovery spine's metadata source (Doc §3b: "Discovery spine
// (JustWatch model): TMDB (metadata) + Watchmode + Trakt"). TMDB is the
// canonical title/cast/artwork database the whole Entertainment vertical hangs
// off of.
//
// Free tier: a free API key (v3) sent as the `api_key` query param, OR a v4
// read-access bearer token. We support both; key comes from the environment:
//   TMDB_API_KEY            (v3 key, query param)
//   TMDB_READ_ACCESS_TOKEN  (v4 bearer, Authorization header) — preferred if set
//
// Wired through the shared base layer: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode for offline tests. Endpoints covered:
//   GET /search/multi           — unified movie+tv+person search
//   GET /movie/{id}             — movie details
//   GET /tv/{id}                — tv details
//   GET /trending/{mt}/{window} — trending feed
// Image URLs are built from TMDB's documented CDN base + a poster size.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const TMDB_BASE_URL = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export class TmdbClient {
  constructor({
    baseUrl = TMDB_BASE_URL,
    apiKey = process.env.TMDB_API_KEY ?? null,
    readToken = process.env.TMDB_READ_ACCESS_TOKEN ?? null,
    fixtureMode = false,
    // TMDB allows ~50 req/s but we stay polite.
    rateLimiter = new TokenBucket({ capacity: 20, refillPerSec: 10 }),
    cache = new TTLCache({ ttlMs: 600_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    this.readToken = readToken;
    const defaultHeaders = readToken ? { Authorization: `Bearer ${readToken}` } : {};
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => tmdbFixtureName(url),
        ...httpOpts,
      });
  }

  // Append api_key only when we are NOT using a v4 bearer token.
  _params(extra = {}) {
    const p = new URLSearchParams(extra);
    if (!this.readToken && this.apiKey) p.set("api_key", this.apiKey);
    return p;
  }

  // GET /search/multi?query=... — movies + tv + people in one call.
  async searchMulti({ query, page = 1, includeAdult = false } = {}) {
    const q = reqQuery(query);
    const params = this._params({ query: q, page: String(page), include_adult: String(includeAdult) });
    const raw = await this.http.getJson(`/search/multi?${params.toString()}`, {
      fixture: "tmdb-search-multi",
    });
    if (!Array.isArray(raw?.results)) {
      throw new AdapterError("tmdb search: expected results array", { details: { got: typeof raw?.results } });
    }
    return {
      page: raw.page ?? page,
      totalPages: raw.total_pages ?? null,
      totalResults: raw.total_results ?? null,
      results: raw.results.map(shapeSearchRow),
    };
  }

  // GET /movie/{id}
  async movie(id) {
    const params = this._params();
    const raw = await this.http.getJson(`/movie/${reqId(id)}?${params.toString()}`, {
      fixture: "tmdb-movie",
    });
    return shapeMovie(raw);
  }

  // GET /tv/{id}
  async tv(id) {
    const params = this._params();
    const raw = await this.http.getJson(`/tv/${reqId(id)}?${params.toString()}`, {
      fixture: "tmdb-tv",
    });
    return shapeTv(raw);
  }

  // GET /trending/{mediaType}/{window}  (mediaType: all|movie|tv, window: day|week)
  async trending({ mediaType = "all", window = "day" } = {}) {
    const mt = ["all", "movie", "tv"].includes(mediaType) ? mediaType : "all";
    const win = window === "week" ? "week" : "day";
    const params = this._params();
    const raw = await this.http.getJson(`/trending/${mt}/${win}?${params.toString()}`, {
      fixture: "tmdb-trending",
    });
    if (!Array.isArray(raw?.results)) {
      throw new AdapterError("tmdb trending: expected results array", { details: { got: typeof raw?.results } });
    }
    return raw.results.map(shapeSearchRow);
  }

  // Build a full poster/backdrop URL from a TMDB image path.
  imageUrl(path, size = "w500") {
    if (!path) return null;
    return `${TMDB_IMAGE_BASE}/${size}${path}`;
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
  const mediaType = r.media_type ?? (r.title ? "movie" : r.name ? "tv" : "unknown");
  return {
    id: r.id,
    mediaType,
    title: r.title ?? r.name ?? null,
    originalTitle: r.original_title ?? r.original_name ?? null,
    overview: r.overview ?? null,
    releaseDate: r.release_date ?? r.first_air_date ?? null,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    voteAverage: r.vote_average != null ? Number(r.vote_average) : null,
    popularity: r.popularity != null ? Number(r.popularity) : null,
  };
}

function shapeMovie(r) {
  if (r == null || typeof r !== "object") {
    throw new AdapterError("tmdb movie: unexpected payload", { details: { got: typeof r } });
  }
  return {
    id: r.id,
    mediaType: "movie",
    title: r.title ?? null,
    originalTitle: r.original_title ?? null,
    overview: r.overview ?? null,
    releaseDate: r.release_date ?? null,
    runtime: r.runtime ?? null,
    genres: Array.isArray(r.genres) ? r.genres.map((g) => g.name) : [],
    imdbId: r.imdb_id ?? null,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    voteAverage: r.vote_average != null ? Number(r.vote_average) : null,
    status: r.status ?? null,
  };
}

function shapeTv(r) {
  if (r == null || typeof r !== "object") {
    throw new AdapterError("tmdb tv: unexpected payload", { details: { got: typeof r } });
  }
  return {
    id: r.id,
    mediaType: "tv",
    title: r.name ?? null,
    originalTitle: r.original_name ?? null,
    overview: r.overview ?? null,
    firstAirDate: r.first_air_date ?? null,
    lastAirDate: r.last_air_date ?? null,
    numberOfSeasons: r.number_of_seasons ?? null,
    numberOfEpisodes: r.number_of_episodes ?? null,
    genres: Array.isArray(r.genres) ? r.genres.map((g) => g.name) : [],
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    voteAverage: r.vote_average != null ? Number(r.vote_average) : null,
    status: r.status ?? null,
  };
}

function tmdbFixtureName(url) {
  if (url.includes("/search/multi")) return "tmdb-search-multi";
  if (url.includes("/trending/")) return "tmdb-trending";
  if (/\/movie\/\d/.test(url)) return "tmdb-movie";
  if (/\/tv\/\d/.test(url)) return "tmdb-tv";
  return null;
}
