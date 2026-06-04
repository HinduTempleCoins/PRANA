// ccmixter.mjs — typed ccMixter client (EE2-4).
//
// ccMixter (ccmixter.org) is a community remix site; every upload is released
// under a Creative Commons or CC0 license, and many tracks are explicitly
// cleared for sampling/remix. This adapter covers two read calls against the
// public query API (no key required):
//   - GET /api/query?search=...&f=json         -> search remixes/uploads
//   - GET /api/query?ids=<id>&f=json           -> fetch one upload by id
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, fixture mode for offline tests.
//
// License/attribution: ccMixter returns a `license_url` and `artist` per upload.
// Each shaped record surfaces a normalized `license` block and `attribution`
// so the license-router can tier it. Because ccMixter is remix-culture, the
// attribution block also flags `remixOk` (derivatives allowed) explicitly.
//
// API key: none required for the public query API. An optional API key is sent
// as the `key` query param when CCMIXTER_API_KEY is set (documented fallback:
// none — public reads work key-less).

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { classifyCcLicense } from "./jamendo.mjs";

export const CCMIXTER_BASE_URL = "https://ccmixter.org";

export function resolveCcmixterApiKey(env = process.env) {
  return env.CCMIXTER_API_KEY || null;
}

export class CcMixterClient {
  constructor({
    baseUrl = CCMIXTER_BASE_URL,
    apiKey = resolveCcmixterApiKey(),
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
        fixtureResolver: (url) => ccmixterFixtureName(url),
        ...httpOpts,
      });
  }

  _params(extra = {}) {
    const p = new URLSearchParams({ f: "json", ...extra });
    if (this.apiKey) p.set("key", this.apiKey);
    return p;
  }

  // GET /api/query?search=<q>&f=json  -> array of typed uploads.
  async search({ query, limit = 20, offset = 0, sort = "rank" } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = this._params({
      search: String(query).trim(),
      limit: String(limit),
      offset: String(offset),
      sort: String(sort),
    });
    const raw = await this.http.getJson(`/api/query?${params.toString()}`, {
      fixture: "ccmixter-search",
    });
    return shapeUploadList(raw);
  }

  // GET /api/query?ids=<id>&f=json  -> one typed upload (or null).
  async fetchById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const params = this._params({ ids: String(id) });
    const raw = await this.http.getJson(`/api/query?${params.toString()}`, {
      fixture: "ccmixter-upload-by-id",
    });
    const list = shapeUploadList(raw);
    return list[0] ?? null;
  }
}

// ---- shaping / typing helpers -------------------------------------------

function shapeUploadList(raw) {
  // ccMixter returns a bare JSON array of upload records.
  const rows = Array.isArray(raw) ? raw : raw && Array.isArray(raw.results) ? raw.results : null;
  if (rows == null) {
    throw new AdapterError("ccmixter: expected an array payload", { details: { got: typeof raw } });
  }
  return rows.map(shapeUpload);
}

function shapeUpload(u) {
  const license = classifyCcLicense(u.license_url);
  // ccMixter exposes the primary download file in upload_files[0].
  const file = Array.isArray(u.files) && u.files.length ? u.files[0] : null;
  const downloadUrl = file?.download_url ?? u.file_page_url ?? null;
  return {
    source: "ccmixter",
    id: String(u.upload_id ?? u.id),
    title: u.upload_name ?? u.name ?? null,
    artist: u.user_real_name || u.user_name || null,
    artistId: u.user_name ?? null,
    durationSec: file?.file_seconds != null ? Number(file.file_seconds) : null,
    audioUrl: file?.download_url ?? null,
    downloadUrl,
    pageUrl: u.file_page_url ?? u.user_page_url ?? null,
    image: u.upload_image ?? null,
    license,
    attribution: {
      artist: u.user_real_name || u.user_name || null,
      artistUrl: u.user_page_url ?? (u.user_name ? `https://ccmixter.org/people/${u.user_name}` : null),
      source: u.file_page_url ?? null,
      requiredCredit: license.tier !== "public-domain",
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      // ccMixter is remix-first; surface remix/derivative permission explicitly.
      remixOk: license.derivativesOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

function ccmixterFixtureName(url) {
  if (/[?&]ids=/.test(url)) return "ccmixter-upload-by-id";
  if (url.includes("/api/query")) return "ccmixter-search";
  return null;
}
