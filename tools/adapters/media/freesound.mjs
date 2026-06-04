// freesound.mjs — typed Freesound client (EE2-3).
//
// Freesound (freesound.org) is a collaborative database of CC-licensed sounds.
// This adapter covers the two read endpoints the catalog needs:
//   - GET /apiv2/search/text/?query=...   -> search sounds
//   - GET /apiv2/sounds/<id>/             -> fetch one sound by id
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, fixture mode for offline tests.
//
// License/attribution: Freesound exposes a license URL per sound (a Creative
// Commons or CC0 deed). Each shaped sound surfaces a normalized `license` block
// and `attribution` ({ author, source, requiredCredit, shareAlike, ... }) so
// the license-router can tier it (CC0 / CC-BY / CC-BY-NC / Sampling+).
//
// API key: Freesound requires a token. The simplest scheme is a token-auth API
// key sent as `Authorization: Token <key>`. Read from FREESOUND_API_KEY env.
// Documented fallback: a clearly-fake "DEMO_TOKEN" placeholder so fixture-mode
// tests need no network and no real secret; real calls 401 without a key.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { classifyCcLicense } from "./jamendo.mjs";

export const FREESOUND_BASE_URL = "https://freesound.org/apiv2";

export const FREESOUND_FALLBACK_TOKEN = "DEMO_TOKEN";

export function resolveFreesoundToken(env = process.env) {
  return env.FREESOUND_API_KEY || FREESOUND_FALLBACK_TOKEN;
}

// Fields we ask Freesound to include so license/attribution are always present.
const SOUND_FIELDS = [
  "id",
  "name",
  "username",
  "license",
  "url",
  "previews",
  "download",
  "duration",
  "tags",
  "description",
  "images",
].join(",");

export class FreesoundClient {
  constructor({
    baseUrl = FREESOUND_BASE_URL,
    token = resolveFreesoundToken(),
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.token = token;
    const defaultHeaders = token ? { Authorization: `Token ${token}` } : {};
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => freesoundFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /search/text/?query=<q>  -> { count, results: [typed sounds] }.
  async search({ query, page = 1, pageSize = 20, filter = null } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = new URLSearchParams({
      query: String(query).trim(),
      page: String(page),
      page_size: String(pageSize),
      fields: SOUND_FIELDS,
    });
    if (filter) params.set("filter", String(filter));
    const raw = await this.http.getJson(`/search/text/?${params.toString()}`, {
      fixture: "freesound-search",
    });
    return shapeSearchResponse(raw);
  }

  // GET /sounds/<id>/  -> one typed sound (or null).
  async fetchById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const params = new URLSearchParams({ fields: SOUND_FIELDS });
    const raw = await this.http.getJson(`/sounds/${encodeURIComponent(id)}/?${params.toString()}`, {
      fixture: "freesound-sound-by-id",
    });
    if (raw == null || typeof raw !== "object") {
      throw new AdapterError("sound: unexpected payload", { details: { got: typeof raw } });
    }
    if (raw.detail && raw.id == null) return null; // Freesound 404 shape
    return shapeSound(raw);
  }
}

// ---- shaping / typing helpers -------------------------------------------

function shapeSearchResponse(raw) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("search: unexpected payload", { details: { got: typeof raw } });
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new AdapterError("search: expected results[] payload", { details: { got: typeof results } });
  }
  return {
    count: raw.count != null ? Number(raw.count) : results.length,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: results.map(shapeSound),
  };
}

function shapeSound(s) {
  const license = classifyCcLicense(s.license);
  const previews = s.previews ?? {};
  return {
    source: "freesound",
    id: String(s.id),
    title: s.name ?? null,
    author: s.username ?? null,
    durationSec: s.duration != null ? Number(s.duration) : null,
    previewUrl: previews["preview-hq-mp3"] ?? previews["preview-lq-mp3"] ?? null,
    downloadUrl: s.download ?? null,
    pageUrl: s.url ?? null,
    image: s.images?.waveform_m ?? s.images?.spectral_m ?? null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    description: s.description ?? null,
    license,
    attribution: {
      author: s.username ?? null,
      authorUrl: s.username ? `https://freesound.org/people/${s.username}/` : null,
      source: s.url ?? null,
      requiredCredit: license.tier !== "public-domain",
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

function freesoundFixtureName(url) {
  if (url.includes("/search/text")) return "freesound-search";
  if (/\/sounds\//.test(url)) return "freesound-sound-by-id";
  return null;
}
