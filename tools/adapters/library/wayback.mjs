// wayback.mjs — typed Wayback Machine client (DD2-5).
//
// Read-only, key-less clients over the Internet Archive Wayback Machine:
//   - GET https://archive.org/wayback/available?url=...[&timestamp=YYYYMMDD...]
//        -> Availability API: the single closest capture (a POINTER).
//   - GET https://web.archive.org/cdx/search/cdx?url=...&output=json
//        -> CDX server: the list of capture timestamps for a URL (POINTERS).
//
// ⚠️ NEVER RE-HOST. This adapter deals ONLY in capture-window POINTERS:
//   the archived snapshot URL (https://web.archive.org/web/<timestamp>/<url>)
//   and its timestamp/status. It does NOT, and must not, fetch or store the
//   captured page bytes. Downstream consumers link out to web.archive.org; they
//   do not proxy it. This is the WINDOW tier of the tier-routing model — point
//   at the capture, do not mirror it. See ../../design/library/tier-routing-spec.md.
//
// Wired through the W9 base layer like every other adapter here.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LibraryHttpClient } from "./library-base.mjs";

export const WAYBACK_AVAILABLE_BASE = "https://archive.org";
export const WAYBACK_CDX_BASE = "https://web.archive.org";
export const WAYBACK_REPLAY_BASE = "https://web.archive.org/web";

export class WaybackClient {
  constructor({
    availableBaseUrl = WAYBACK_AVAILABLE_BASE,
    cdxBaseUrl = WAYBACK_CDX_BASE,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    availableHttp = null,
    cdxHttp = null,
    ...httpOpts
  } = {}) {
    const common = { fixtureMode, rateLimiter, cache, fixtureResolver: waybackFixtureName, ...httpOpts };
    this.availableHttp =
      availableHttp ?? new LibraryHttpClient({ baseUrl: availableBaseUrl, ...common });
    this.cdxHttp = cdxHttp ?? new LibraryHttpClient({ baseUrl: cdxBaseUrl, ...common });
  }

  // GET /wayback/available?url=...[&timestamp=...] -> closest capture pointer.
  // `timestamp` is an optional YYYY[MM[DD[hh[mm[ss]]]]] target; Wayback returns
  // the closest capture to it. Returns { available, snapshot|null }.
  async available({ url, timestamp } = {}) {
    const target = String(url ?? "").trim();
    if (!target) throw new AdapterError("available: url is required", { details: { url } });
    const params = new URLSearchParams({ url: target });
    if (timestamp != null && String(timestamp).trim()) {
      params.set("timestamp", normTimestamp(timestamp));
    }
    const raw = await this.availableHttp.getJson(`/wayback/available?${params.toString()}`, {
      fixture: "wayback-available",
    });
    return shapeAvailable(raw, target);
  }

  // GET /cdx/search/cdx?url=...&output=json[&from=&to=&limit=&filter=] -> the
  // capture list (each row is a capture-window pointer, NOT the bytes).
  async captures({ url, from, to, limit, filter, collapse, matchType } = {}) {
    const target = String(url ?? "").trim();
    if (!target) throw new AdapterError("captures: url is required", { details: { url } });
    const params = new URLSearchParams({ url: target, output: "json" });
    if (from != null) params.set("from", normTimestamp(from));
    if (to != null) params.set("to", normTimestamp(to));
    if (limit != null) params.set("limit", String(limit));
    if (filter != null) params.set("filter", String(filter));
    if (collapse != null) params.set("collapse", String(collapse));
    if (matchType != null) params.set("matchType", String(matchType));

    const raw = await this.cdxHttp.getJson(`/cdx/search/cdx?${params.toString()}`, {
      fixture: "wayback-cdx",
    });
    return shapeCdx(raw);
  }

  // Build the replay (snapshot) POINTER URL for a timestamp + original url.
  // This is a LINK to web.archive.org — the caller navigates there; we never
  // fetch or mirror it.
  replayUrl(timestamp, originalUrl) {
    const ts = normTimestamp(timestamp);
    const u = String(originalUrl ?? "").trim();
    if (!ts || !u) throw new AdapterError("replayUrl: timestamp and originalUrl required");
    return `${WAYBACK_REPLAY_BASE}/${ts}/${u}`;
  }
}

// ---- shaping / typing helpers -------------------------------------------

// Keep only digits; Wayback timestamps are 14-digit (or shorter prefix) numeric.
function normTimestamp(ts) {
  return String(ts ?? "").replace(/[^0-9]/g, "");
}

function shapeAvailable(raw, requestedUrl) {
  const snap = raw?.archived_snapshots?.closest;
  if (snap == null) {
    return { requestedUrl, available: false, snapshot: null };
  }
  return {
    requestedUrl,
    available: snap.available === true || snap.available === "true",
    snapshot: {
      // POINTER URL into web.archive.org — never the page bytes.
      url: snap.url ?? null,
      timestamp: snap.timestamp ?? null,
      status: snap.status != null ? String(snap.status) : null,
    },
  };
}

// CDX JSON is a header-row array: [ [field,...], [value,...], ... ].
function shapeCdx(raw) {
  if (!Array.isArray(raw)) {
    throw new AdapterError("captures: expected a CDX JSON array", { details: { got: typeof raw } });
  }
  if (raw.length === 0) return { fields: [], captures: [] };
  const [header, ...rows] = raw;
  if (!Array.isArray(header)) {
    throw new AdapterError("captures: malformed CDX header row", { details: { header } });
  }
  const captures = rows
    .filter((r) => Array.isArray(r))
    .map((r) => {
      const rec = {};
      header.forEach((field, i) => {
        rec[field] = r[i] ?? null;
      });
      // Surface a ready-made replay POINTER when we have the pieces.
      if (rec.timestamp && rec.original) {
        rec.replayUrl = `${WAYBACK_REPLAY_BASE}/${normTimestamp(rec.timestamp)}/${rec.original}`;
      }
      return rec;
    });
  return { fields: header, captures };
}

export function waybackFixtureName(url) {
  if (url.includes("/wayback/available")) return "wayback-available";
  if (url.includes("/cdx/search/cdx")) return "wayback-cdx";
  return null;
}
