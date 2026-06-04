// musopen.mjs — typed Musopen client (EE2-5).
//
// Musopen (musopen.org) hosts public-domain and CC recordings of classical
// music plus public-domain sheet music. This adapter covers search + fetch
// across both asset kinds:
//   - GET /api/v1/recordings/?search=...   -> search recordings (audio)
//   - GET /api/v1/recordings/<id>/         -> fetch one recording by id
//   - GET /api/v1/music-sheets/?search=... -> search sheet music
//   - GET /api/v1/music-sheets/<id>/       -> fetch one sheet by id
//
// (Musopen's hosted API path is configurable via MUSOPEN_BASE_URL so an
// operator can repoint it without code changes.)
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, fixture mode for offline tests.
//
// License/attribution: Musopen's core value is public-domain content, but it
// also carries CC recordings, so each shaped asset surfaces a normalized
// `license` block. Public-domain assets are tiered "public-domain" with
// requiredCredit=false; CC assets are classified by their deed URL. Composer +
// performer are surfaced for courtesy credit even when not legally required.
//
// API key: Musopen uses a token for authenticated endpoints. Read from
// MUSOPEN_API_KEY env and send as `Authorization: Token <key>` when present.
// Documented fallback: none — public catalog reads work key-less.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { classifyCcLicense } from "./jamendo.mjs";

export const MUSOPEN_FALLBACK_BASE_URL = "https://musopen.org";

export function resolveMusopenBaseUrl(env = process.env) {
  return env.MUSOPEN_BASE_URL || MUSOPEN_FALLBACK_BASE_URL;
}

export function resolveMusopenApiKey(env = process.env) {
  return env.MUSOPEN_API_KEY || null;
}

export class MusopenClient {
  constructor({
    baseUrl = resolveMusopenBaseUrl(),
    apiKey = resolveMusopenApiKey(),
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    const defaultHeaders = apiKey ? { Authorization: `Token ${apiKey}` } : {};
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => musopenFixtureName(url),
        ...httpOpts,
      });
  }

  // ---- recordings (audio) ----

  // GET /api/v1/recordings/?search=<q>
  async search({ query, page = 1, pageSize = 20 } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = new URLSearchParams({
      search: String(query).trim(),
      page: String(page),
      page_size: String(pageSize),
    });
    const raw = await this.http.getJson(`/api/v1/recordings/?${params.toString()}`, {
      fixture: "musopen-recordings-search",
    });
    return shapeListResponse(raw, shapeRecording);
  }

  // GET /api/v1/recordings/<id>/
  async fetchById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const raw = await this.http.getJson(`/api/v1/recordings/${encodeURIComponent(id)}/`, {
      fixture: "musopen-recording-by-id",
    });
    return shapeSingle(raw, shapeRecording);
  }

  // ---- sheet music ----

  // GET /api/v1/music-sheets/?search=<q>
  async searchSheetMusic({ query, page = 1, pageSize = 20 } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = new URLSearchParams({
      search: String(query).trim(),
      page: String(page),
      page_size: String(pageSize),
    });
    const raw = await this.http.getJson(`/api/v1/music-sheets/?${params.toString()}`, {
      fixture: "musopen-sheets-search",
    });
    return shapeListResponse(raw, shapeSheet);
  }

  // GET /api/v1/music-sheets/<id>/
  async fetchSheetMusicById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const raw = await this.http.getJson(`/api/v1/music-sheets/${encodeURIComponent(id)}/`, {
      fixture: "musopen-sheet-by-id",
    });
    return shapeSingle(raw, shapeSheet);
  }
}

// ---- shaping / typing helpers -------------------------------------------

// Map Musopen's license field (a string like "Public Domain" or a CC deed URL)
// to a normalized license block.
function classifyMusopenLicense(value) {
  const raw = String(value ?? "").trim();
  if (/creativecommons\.org/i.test(raw)) return classifyCcLicense(raw);
  if (/public\s*domain|^pd$|cc0/i.test(raw)) {
    return {
      name: raw || "Public Domain",
      url: null,
      tier: "public-domain",
      ccVersion: null,
      shareAlike: false,
      commercialOk: true,
      derivativesOk: true,
    };
  }
  if (!raw) {
    // Musopen's default catalog is PD; absent an explicit license, tier as PD
    // but flag it so the router can require manual review.
    return { name: "Public Domain (assumed)", url: null, tier: "public-domain", ccVersion: null, shareAlike: false, commercialOk: true, derivativesOk: true, assumed: true };
  }
  return { name: raw, url: null, tier: "unknown", ccVersion: null, shareAlike: false, commercialOk: false, derivativesOk: false };
}

function shapeListResponse(raw, shaper) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("musopen: unexpected payload", { details: { got: typeof raw } });
  }
  // DRF-style pagination { count, next, previous, results } or bare array.
  const results = Array.isArray(raw) ? raw : raw.results;
  if (!Array.isArray(results)) {
    throw new AdapterError("musopen: expected results[] payload", { details: { got: typeof results } });
  }
  return {
    count: raw.count != null ? Number(raw.count) : results.length,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: results.map(shaper),
  };
}

function shapeSingle(raw, shaper) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("musopen: unexpected payload", { details: { got: typeof raw } });
  }
  if (raw.detail && raw.id == null) return null; // not-found shape
  return shaper(raw);
}

function shapeRecording(r) {
  const license = classifyMusopenLicense(r.license ?? r.license_url);
  return {
    source: "musopen",
    kind: "recording",
    id: String(r.id),
    title: r.title ?? r.name ?? null,
    composer: pickName(r.composer),
    performers: pickPerformers(r.performers),
    instrument: pickName(r.instrument),
    period: pickName(r.period),
    durationSec: r.duration != null ? Number(r.duration) : null,
    audioUrl: r.url ?? r.file ?? r.download_url ?? null,
    downloadUrl: r.download_url ?? r.file ?? null,
    pageUrl: r.slug ? `https://musopen.org/music/${r.slug}/` : null,
    license,
    attribution: {
      composer: pickName(r.composer),
      performers: pickPerformers(r.performers),
      source: r.slug ? `https://musopen.org/music/${r.slug}/` : null,
      requiredCredit: license.tier !== "public-domain",
      courtesyCredit: true, // always credit composer/performer as courtesy
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

function shapeSheet(s) {
  const license = classifyMusopenLicense(s.license ?? s.license_url);
  return {
    source: "musopen",
    kind: "sheet-music",
    id: String(s.id),
    title: s.title ?? s.name ?? null,
    composer: pickName(s.composer),
    instrumentation: pickName(s.instrumentation ?? s.instrument),
    pages: s.pages != null ? Number(s.pages) : null,
    pdfUrl: s.pdf ?? s.file ?? s.download_url ?? null,
    downloadUrl: s.download_url ?? s.pdf ?? s.file ?? null,
    pageUrl: s.slug ? `https://musopen.org/sheetmusic/${s.slug}/` : null,
    license,
    attribution: {
      composer: pickName(s.composer),
      source: s.slug ? `https://musopen.org/sheetmusic/${s.slug}/` : null,
      requiredCredit: license.tier !== "public-domain",
      courtesyCredit: true,
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

// Musopen relational fields can be a string, an object {name}, or an id.
function pickName(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.name ?? v.full_name ?? v.title ?? null;
  return String(v);
}

function pickPerformers(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(pickName).filter(Boolean);
  const one = pickName(v);
  return one ? [one] : [];
}

function musopenFixtureName(url) {
  if (url.includes("/music-sheets/")) {
    return /\/music-sheets\/\d+/.test(url) ? "musopen-sheet-by-id" : "musopen-sheets-search";
  }
  if (url.includes("/recordings/")) {
    return /\/recordings\/\d+/.test(url) ? "musopen-recording-by-id" : "musopen-recordings-search";
  }
  return null;
}
