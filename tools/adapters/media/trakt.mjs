// trakt.mjs — Trakt history/lists/scrobble-metadata adapter (EE2-9).
//
// The user-activity arm of the discovery spine (Doc §3b: TMDB metadata +
// Watchmode where-to-watch + **Trakt (history/lists/scrobble metadata)**).
// Trakt tracks what a user has watched, their lists, and trending/popular
// charts. This adapter covers the READ-only metadata surface (no OAuth write,
// no actual scrobbling) the feed needs.
//
// Trakt auth: every request needs the app's `trakt-api-key` (client id) and a
// `trakt-api-version: 2` header. User-scoped reads additionally need an OAuth
// bearer access token. From env:
//   TRAKT_CLIENT_ID       (required: trakt-api-key header)
//   TRAKT_ACCESS_TOKEN    (optional: bearer, for user history/lists)
//
// Wired through the shared base layer: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. Endpoints covered:
//   GET /movies/trending          — trending movies (public)
//   GET /shows/popular            — popular shows (public)
//   GET /users/{id}/history       — a user's watch history (needs token)
//   GET /users/{id}/lists         — a user's personal lists (needs token)

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const TRAKT_BASE_URL = "https://api.trakt.tv";

export class TraktClient {
  constructor({
    baseUrl = TRAKT_BASE_URL,
    clientId = process.env.TRAKT_CLIENT_ID ?? null,
    accessToken = process.env.TRAKT_ACCESS_TOKEN ?? null,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.clientId = clientId;
    this.accessToken = accessToken;
    const defaultHeaders = {
      "trakt-api-version": "2",
      "Content-Type": "application/json",
    };
    if (clientId) defaultHeaders["trakt-api-key"] = clientId;
    if (accessToken) defaultHeaders.Authorization = `Bearer ${accessToken}`;
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => traktFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /movies/trending?page=&limit=
  async trendingMovies({ page = 1, limit = 10 } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const raw = await this.http.getJson(`/movies/trending?${params.toString()}`, {
      fixture: "trakt-trending-movies",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("trakt trending: expected array", { details: { got: typeof raw } });
    }
    // trending rows wrap the movie under .movie with a .watchers count.
    return raw.map((r) => ({ watchers: r.watchers ?? null, ...shapeMovie(r.movie ?? r) }));
  }

  // GET /shows/popular?page=&limit=
  async popularShows({ page = 1, limit = 10 } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const raw = await this.http.getJson(`/shows/popular?${params.toString()}`, {
      fixture: "trakt-popular-shows",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("trakt popular: expected array", { details: { got: typeof raw } });
    }
    return raw.map(shapeShow);
  }

  // GET /users/{id}/history  (needs OAuth token).
  async userHistory(userId, { type = null, page = 1, limit = 10 } = {}) {
    const id = reqId(userId);
    const seg = type ? `/${encodeURIComponent(type)}` : "";
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const raw = await this.http.getJson(`/users/${id}/history${seg}?${params.toString()}`, {
      fixture: "trakt-user-history",
    });
    if (!Array.isArray(raw)) {
      throw new AdapterError("trakt history: expected array", { details: { got: typeof raw } });
    }
    return raw.map(shapeHistoryRow);
  }

  // GET /users/{id}/lists  (needs OAuth token for private; public lists are open).
  async userLists(userId) {
    const id = reqId(userId);
    const raw = await this.http.getJson(`/users/${id}/lists`, { fixture: "trakt-user-lists" });
    if (!Array.isArray(raw)) {
      throw new AdapterError("trakt lists: expected array", { details: { got: typeof raw } });
    }
    return raw.map(shapeList);
  }
}

// ---- shaping helpers ----------------------------------------------------

function reqId(id) {
  if (id == null || String(id).trim() === "") throw new AdapterError("userId is required");
  return encodeURIComponent(String(id));
}

function shapeIds(ids = {}) {
  return {
    trakt: ids.trakt ?? null,
    slug: ids.slug ?? null,
    imdb: ids.imdb ?? null,
    tmdb: ids.tmdb ?? null,
  };
}
function shapeMovie(m = {}) {
  return { type: "movie", title: m.title ?? null, year: m.year ?? null, ids: shapeIds(m.ids) };
}
function shapeShow(s = {}) {
  return { type: "show", title: s.title ?? null, year: s.year ?? null, ids: shapeIds(s.ids) };
}
function shapeHistoryRow(r) {
  const out = {
    id: r.id ?? null,
    watchedAt: r.watched_at ?? null,
    action: r.action ?? null,
    type: r.type ?? null,
  };
  if (r.movie) out.item = shapeMovie(r.movie);
  else if (r.show) out.item = shapeShow(r.show);
  else out.item = null;
  if (r.episode) {
    out.episode = {
      season: r.episode.season ?? null,
      number: r.episode.number ?? null,
      title: r.episode.title ?? null,
      ids: shapeIds(r.episode.ids),
    };
  }
  return out;
}
function shapeList(l) {
  return {
    name: l.name ?? null,
    description: l.description ?? null,
    privacy: l.privacy ?? null,
    itemCount: l.item_count ?? null,
    likes: l.likes ?? null,
    ids: shapeIds(l.ids),
  };
}

function traktFixtureName(url) {
  if (url.includes("/movies/trending")) return "trakt-trending-movies";
  if (url.includes("/shows/popular")) return "trakt-popular-shows";
  if (url.includes("/history")) return "trakt-user-history";
  if (url.includes("/lists")) return "trakt-user-lists";
  return null;
}
