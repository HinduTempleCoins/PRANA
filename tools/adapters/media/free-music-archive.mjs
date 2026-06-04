// free-music-archive.mjs — typed Free Music Archive (FMA) client (EE2-2).
//
// FMA is a library of free, legal CC- and PD-licensed audio. This adapter
// covers two read endpoints:
//   - GET /api/trackSearch?q=...    -> search tracks
//   - GET /api/getAudioFile?id=...  -> fetch one track by id
//
// (FMA's hosted API has moved hosts over the years; the path shape here is the
// REST surface the catalog targets. Real base URL is configurable via the
// FMA_BASE_URL env var so an operator can repoint it without code changes.)
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, fixture mode for offline tests.
//
// License/attribution: every shaped track carries a normalized `license` block
// and `attribution` so the license-router can tier PD vs CC-BY vs CC-BY-SA vs
// CC-BY-NC, etc. FMA exposes license name + url per track.
//
// API key: FMA's public catalog reads do not require a key. An optional key is
// supported via FMA_API_KEY and sent as the `api_key` query param when present
// (documented fallback: none — calls work key-less).

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { classifyCcLicense } from "./jamendo.mjs";

export const FMA_FALLBACK_BASE_URL = "https://freemusicarchive.org";

export function resolveFmaBaseUrl(env = process.env) {
  return env.FMA_BASE_URL || FMA_FALLBACK_BASE_URL;
}

export function resolveFmaApiKey(env = process.env) {
  return env.FMA_API_KEY || null;
}

export class FreeMusicArchiveClient {
  constructor({
    baseUrl = resolveFmaBaseUrl(),
    apiKey = resolveFmaApiKey(),
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
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
        fixtureResolver: (url) => fmaFixtureName(url),
        ...httpOpts,
      });
  }

  _withKey(params) {
    if (this.apiKey) params.set("api_key", this.apiKey);
    return params;
  }

  // GET /api/trackSearch?q=<query>  -> array of typed tracks.
  async search({ query, limit = 20, page = 1 } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = this._withKey(
      new URLSearchParams({
        q: String(query).trim(),
        limit: String(limit),
        page: String(page),
      })
    );
    const raw = await this.http.getJson(`/api/trackSearch?${params.toString()}`, {
      fixture: "fma-track-search",
    });
    return shapeTrackList(raw);
  }

  // GET /api/getAudioFile?id=<id>  -> one typed track (or null).
  async fetchById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const params = this._withKey(new URLSearchParams({ id: String(id) }));
    const raw = await this.http.getJson(`/api/getAudioFile?${params.toString()}`, {
      fixture: "fma-track-by-id",
    });
    const list = shapeTrackList(raw);
    return list[0] ?? null;
  }
}

// ---- shaping / typing helpers -------------------------------------------

// FMA wraps results in { aTracks: [...] } (legacy) or { dataset: [...] };
// accept either, plus a bare array, so a host repoint does not break shaping.
function extractRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.aTracks)) return raw.aTracks;
    if (Array.isArray(raw.dataset)) return raw.dataset;
    if (Array.isArray(raw.results)) return raw.results;
    if (raw.track_id != null || raw.id != null) return [raw]; // single object
  }
  return null;
}

function shapeTrackList(raw) {
  const rows = extractRows(raw);
  if (rows == null) {
    throw new AdapterError("fma: unexpected payload (no track rows)", { details: { got: typeof raw } });
  }
  return rows.map(shapeTrack);
}

function shapeTrack(t) {
  // FMA may give a license URL (license_url) and/or a license title.
  const licenseUrl = t.license_url || t.track_license_url || null;
  let license = classifyCcLicense(licenseUrl);
  if (license.tier === "unknown" && (t.license_title || t.license)) {
    license = { ...license, name: t.license_title || t.license };
  }
  return {
    source: "free-music-archive",
    id: String(t.track_id ?? t.id),
    title: t.track_title ?? t.title ?? null,
    artist: t.artist_name ?? t.artist ?? null,
    artistId: t.artist_id != null ? String(t.artist_id) : null,
    album: t.album_title ?? t.album ?? null,
    durationSec: parseDuration(t.track_duration ?? t.duration),
    audioUrl: t.track_file_url ?? t.audio_url ?? t.track_url ?? null,
    downloadUrl: t.track_file_url ?? t.download_url ?? null,
    pageUrl: t.track_url ?? t.url ?? null,
    image: t.track_image_file ?? t.image ?? null,
    genres: Array.isArray(t.track_genres) ? t.track_genres.map((g) => g.genre_title ?? g) : [],
    license,
    attribution: {
      artist: t.artist_name ?? t.artist ?? null,
      artistUrl: t.artist_url ?? null,
      source: t.track_url ?? t.url ?? null,
      requiredCredit: license.tier !== "public-domain",
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

// FMA durations are sometimes "mm:ss" strings, sometimes seconds.
function parseDuration(d) {
  if (d == null) return null;
  if (typeof d === "number") return d;
  const s = String(d).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

function fmaFixtureName(url) {
  if (url.includes("/getAudioFile")) return "fma-track-by-id";
  if (url.includes("/trackSearch")) return "fma-track-search";
  return null;
}
