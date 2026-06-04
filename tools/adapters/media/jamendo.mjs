// jamendo.mjs — typed Jamendo client (EE2-1).
//
// Jamendo is a catalog of Creative-Commons-licensed music. This adapter covers
// the two read endpoints the media catalog needs:
//   - GET /v3.0/tracks?search=...   -> search CC tracks
//   - GET /v3.0/tracks?id=...       -> fetch one track by id
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, and fixture mode for offline tests.
//
// License/attribution: every shaped track surfaces a normalized `license`
// block ({ name, url, tier, ccVersion }) plus `attribution` ({ artist,
// artistUrl, requiredCredit, shareAlike, commercialOk }) so the SoapBox
// license-router can tier each asset (PD / CC-BY / CC-BY-SA / CC-BY-NC ...).
//
// API key: Jamendo requires a free `client_id`. Read from the JAMENDO_CLIENT_ID
// env var. Documented fallback: a clearly-fake "DEMO_CLIENT_ID" placeholder so
// fixture-mode tests run with no network and no real key. Real calls will 401
// without a valid key — that is intentional (no secret is baked in).

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const JAMENDO_BASE_URL = "https://api.jamendo.com/v3.0";

// Documented fallback (placeholder). Override with JAMENDO_CLIENT_ID in env.
export const JAMENDO_FALLBACK_CLIENT_ID = "DEMO_CLIENT_ID";

export function resolveJamendoClientId(env = process.env) {
  return env.JAMENDO_CLIENT_ID || JAMENDO_FALLBACK_CLIENT_ID;
}

// Map a Jamendo Creative-Commons license URL to a normalized license block.
// Jamendo returns license_ccurl like
//   https://creativecommons.org/licenses/by-nc-nd/3.0/
export function classifyCcLicense(ccUrl) {
  const url = String(ccUrl || "");
  const m = url.match(/creativecommons\.org\/(?:licenses|publicdomain)\/([a-z0-9-]+)(?:\/([0-9.]+))?/i);
  if (!m) {
    return { name: "unknown", url: url || null, tier: "unknown", ccVersion: null, shareAlike: false, commercialOk: false, derivativesOk: false };
  }
  const code = m[1].toLowerCase();
  const ccVersion = m[2] || null;
  if (code === "zero" || code === "publicdomain" || code === "mark") {
    return { name: "CC0 / Public Domain", url, tier: "public-domain", ccVersion, shareAlike: false, commercialOk: true, derivativesOk: true };
  }
  const parts = code.split("-"); // e.g. ["by","nc","nd"]
  const shareAlike = parts.includes("sa");
  const commercialOk = !parts.includes("nc");
  const derivativesOk = !parts.includes("nd");
  const tier = `cc-${code}`; // cc-by, cc-by-sa, cc-by-nc-nd, ...
  const name = `CC ${parts.map((p) => p.toUpperCase()).join("-")}${ccVersion ? ` ${ccVersion}` : ""}`;
  return { name, url, tier, ccVersion, shareAlike, commercialOk, derivativesOk };
}

export class JamendoClient {
  constructor({
    baseUrl = JAMENDO_BASE_URL,
    clientId = resolveJamendoClientId(),
    fixtureMode = false,
    // Jamendo free tier is generous; keep a conservative bucket.
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
    http = null, // inject a pre-built HttpClient (tests do this)
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
        fixtureResolver: (url) => jamendoFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /tracks?search=<query>  -> array of typed tracks.
  async search({ query, limit = 20, offset = 0, order = "popularity_total" } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("query is required");
    const params = new URLSearchParams({
      client_id: this.clientId,
      format: "json",
      limit: String(limit),
      offset: String(offset),
      order: String(order),
      search: String(query).trim(),
      include: "musicinfo+licenses",
    });
    const raw = await this.http.getJson(`/tracks?${params.toString()}`, {
      fixture: "jamendo-tracks-search",
    });
    return shapeTracksResponse(raw);
  }

  // GET /tracks?id=<id>  -> one typed track (or null if not found).
  async fetchById(id) {
    if (id == null || !String(id).trim()) throw new AdapterError("id is required");
    const params = new URLSearchParams({
      client_id: this.clientId,
      format: "json",
      id: String(id),
      include: "musicinfo+licenses",
    });
    const raw = await this.http.getJson(`/tracks?${params.toString()}`, {
      fixture: "jamendo-track-by-id",
    });
    const list = shapeTracksResponse(raw);
    return list[0] ?? null;
  }
}

// ---- shaping / typing helpers -------------------------------------------

function shapeTracksResponse(raw) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("tracks: unexpected payload", { details: { got: typeof raw } });
  }
  // Jamendo signals errors inside the body via headers.status === "failed".
  const status = raw.headers?.status;
  if (status && status !== "success") {
    throw new AdapterError("tracks: Jamendo reported failure", {
      details: { status, error: raw.headers?.error_message ?? null },
    });
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new AdapterError("tracks: expected results[] payload", { details: { got: typeof results } });
  }
  return results.map(shapeTrack);
}

function shapeTrack(t) {
  const license = classifyCcLicense(t.license_ccurl);
  return {
    source: "jamendo",
    id: String(t.id),
    title: t.name ?? null,
    artist: t.artist_name ?? null,
    artistId: t.artist_id != null ? String(t.artist_id) : null,
    album: t.album_name ?? null,
    durationSec: t.duration != null ? Number(t.duration) : null,
    audioUrl: t.audio ?? null,
    downloadUrl: t.audiodownload ?? null,
    pageUrl: t.shareurl ?? null,
    image: t.image ?? null,
    license,
    attribution: {
      artist: t.artist_name ?? null,
      artistUrl: t.artist_idstr ? `https://www.jamendo.com/artist/${t.artist_id}/${t.artist_idstr}` : null,
      source: t.shareurl ?? null,
      requiredCredit: license.tier !== "public-domain",
      shareAlike: license.shareAlike,
      commercialOk: license.commercialOk,
      derivativesOk: license.derivativesOk,
    },
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
function jamendoFixtureName(url) {
  if (/[?&]id=/.test(url)) return "jamendo-track-by-id";
  if (url.includes("/tracks")) return "jamendo-tracks-search";
  return null;
}
