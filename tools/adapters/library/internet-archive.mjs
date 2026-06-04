// internet-archive.mjs — typed Internet Archive client (DD2-3).
//
// Read-only, key-less clients over two public archive.org surfaces:
//   - GET https://archive.org/metadata/{identifier}   -> item metadata + files
//   - GET https://archive.org/advancedsearch.php?...   -> scholar/text search
// (Wayback is its own adapter — see ./wayback.mjs.)
//
// Wired through the W9 base layer (rate-limited, TTL-cached, retrying, typed
// errors, fixture mode) like every other adapter here.
//
// IMPORTANT (no re-host): the metadata response lists file names on
// archive.org's own servers. We return a download-URL POINTER built from the
// identifier + file name; we never proxy or store the bytes. Whether a given
// item is HOST-able, WINDOW-only, or AGGREGATE-only is decided by the
// tier-routing layer from the item's license/rights metadata, not here.
// See ../../design/library/tier-routing-spec.md.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LibraryHttpClient } from "./library-base.mjs";

export const IA_BASE_URL = "https://archive.org";
// Download URLs are served from the dn/ download host (also archive.org-hosted).
export const IA_DOWNLOAD_BASE = "https://archive.org/download";

export class InternetArchiveClient {
  constructor({
    baseUrl = IA_BASE_URL,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.http =
      http ??
      new LibraryHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: iaFixtureName,
        ...httpOpts,
      });
  }

  // GET /metadata/{identifier} -> item metadata + file list.
  async metadata(identifier) {
    const id = String(identifier ?? "").trim();
    if (!id) throw new AdapterError("metadata: identifier is required", { details: { identifier } });
    const raw = await this.http.getJson(`/metadata/${encodeURIComponent(id)}`, {
      fixture: "ia-metadata",
    });
    return shapeMetadata(raw, id);
  }

  // GET /advancedsearch.php?q=...&fl[]=...&rows=N&page=P&output=json
  // Returns a shaped result set (docs + numFound). Caller supplies the Lucene
  // query string; we default useful return fields.
  async search({ query, rows = 20, page = 1, fields, mediatype, sort } = {}) {
    const q = String(query ?? "").trim();
    if (!q) throw new AdapterError("search: query is required", { details: { query } });
    const params = new URLSearchParams();
    const fullQ = mediatype ? `${q} AND mediatype:(${mediatype})` : q;
    params.set("q", fullQ);
    const fl = Array.isArray(fields) && fields.length
      ? fields
      : ["identifier", "title", "creator", "year", "mediatype", "licenseurl"];
    for (const f of fl) params.append("fl[]", f);
    if (sort) params.append("sort[]", String(sort));
    params.set("rows", String(rows));
    params.set("page", String(page));
    params.set("output", "json");

    const raw = await this.http.getJson(`/advancedsearch.php?${params.toString()}`, {
      fixture: "ia-search",
    });
    return shapeSearch(raw);
  }

  // Build a POINTER download URL for a file inside an item. Does NOT fetch.
  fileUrl(identifier, fileName) {
    const id = String(identifier ?? "").trim();
    const fn = String(fileName ?? "").trim();
    if (!id || !fn) throw new AdapterError("fileUrl: identifier and fileName required");
    return `${IA_DOWNLOAD_BASE}/${encodeURIComponent(id)}/${encodeURIComponent(fn)}`;
  }
}

// ---- shaping / typing helpers -------------------------------------------

function shapeMetadata(raw, id) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("metadata: unexpected payload", { details: { got: typeof raw } });
  }
  // archive.org returns {} for an unknown identifier.
  if (raw.metadata == null && !Array.isArray(raw.files)) {
    return { identifier: id, found: false, metadata: null, files: [] };
  }
  const m = raw.metadata ?? {};
  const files = Array.isArray(raw.files)
    ? raw.files.map((f) => ({
        name: f.name ?? null,
        format: f.format ?? null,
        size: f.size != null ? Number(f.size) : null,
        source: f.source ?? null,
        // pointer URL only — never the bytes.
        url: f.name ? `${IA_DOWNLOAD_BASE}/${encodeURIComponent(id)}/${encodeURIComponent(f.name)}` : null,
      }))
    : [];
  return {
    identifier: m.identifier ?? id,
    found: true,
    title: m.title ?? null,
    creator: m.creator ?? null,
    mediatype: m.mediatype ?? null,
    // rights/license drive tier routing downstream.
    licenseurl: m.licenseurl ?? null,
    rights: m.rights ?? null,
    publicdate: m.publicdate ?? null,
    year: m.year ?? null,
    server: raw.server ?? null,
    dir: raw.dir ?? null,
    files,
    metadata: m,
  };
}

function shapeSearch(raw) {
  const resp = raw?.response;
  if (resp == null || !Array.isArray(resp.docs)) {
    throw new AdapterError("search: expected { response: { docs: [...] } }", {
      details: { got: typeof raw },
    });
  }
  return {
    numFound: resp.numFound != null ? Number(resp.numFound) : null,
    start: resp.start != null ? Number(resp.start) : null,
    docs: resp.docs.map((d) => ({
      identifier: d.identifier ?? null,
      title: d.title ?? null,
      creator: d.creator ?? null,
      year: d.year ?? null,
      mediatype: d.mediatype ?? null,
      licenseurl: d.licenseurl ?? null,
    })),
  };
}

export function iaFixtureName(url) {
  if (url.includes("/metadata/")) return "ia-metadata";
  if (url.includes("/advancedsearch")) return "ia-search";
  return null;
}
