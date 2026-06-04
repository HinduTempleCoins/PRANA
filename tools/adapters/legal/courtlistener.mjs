// courtlistener.mjs — typed CourtListener API v4 client (SoapBox BB2-1).
//
// READ-ONLY. Covers the Free Law Project's CourtListener REST API v4:
//   - GET /api/rest/v4/search/         -> full-text search (opinions, dockets…)
//   - GET /api/rest/v4/opinions/{id}/  -> one opinion (clusters/cited text)
//   - GET /api/rest/v4/dockets/{id}/   -> one docket
//
// Wired through the shared adapter base (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors (AdapterError/RateLimitError/UpstreamError), and
// fixture mode for offline tests. CourtListener supports an optional token
// ("Authorization: Token <key>") that only raises the rate limit; we read it
// from env (default CL_API_TOKEN) and send it only when present. No key is
// required for read access. paginated responses use DRF's { count, next,
// previous, results } cursor shape.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient, apiKeyFromEnv } from "./legal-base.mjs";

export const COURTLISTENER_BASE_URL = "https://www.courtlistener.com/api/rest/v4";

export class CourtListenerClient {
  constructor({
    baseUrl = COURTLISTENER_BASE_URL,
    apiKey = apiKeyFromEnv("CL_API_TOKEN"), // documented fallback: null (key-less)
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 120_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    const defaultHeaders = apiKey ? { Authorization: `Token ${apiKey}` } : {};
    this.http =
      http ??
      new LegalHttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => courtlistenerFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /search/?q=...&type=o (opinions) | r (RECAP/dockets) — full-text search.
  // Returns { count, next, previous, results: [typed opinion/docket rows] }.
  async search({ q, type = "o", court = null, page = 1 } = {}) {
    if (!q || !String(q).trim()) throw new AdapterError("search: q is required");
    const params = new URLSearchParams({ q: String(q).trim(), type: String(type), page: String(page) });
    if (court) params.set("court", String(court));
    const raw = await this.http.getJson(`/search/?${params.toString()}`, {
      fixture: "courtlistener-search",
    });
    return shapePage(raw, shapeSearchResult);
  }

  // GET /opinions/{id}/ -> one opinion record.
  async getOpinion(id) {
    if (id == null) throw new AdapterError("getOpinion: id is required");
    const raw = await this.http.getJson(`/opinions/${encodeURIComponent(id)}/`, {
      fixture: "courtlistener-opinion",
    });
    return shapeOpinion(raw);
  }

  // GET /dockets/{id}/ -> one docket record.
  async getDocket(id) {
    if (id == null) throw new AdapterError("getDocket: id is required");
    const raw = await this.http.getJson(`/dockets/${encodeURIComponent(id)}/`, {
      fixture: "courtlistener-docket",
    });
    return shapeDocket(raw);
  }
}

// ---- shaping helpers ------------------------------------------------------

// DRF page envelope -> { count, next, previous, results }.
function shapePage(raw, shapeRow) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.results)) {
    throw new AdapterError("expected a DRF page { count, next, previous, results }", {
      details: { got: typeof raw },
    });
  }
  return {
    count: raw.count ?? null,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: raw.results.map(shapeRow),
  };
}

function shapeSearchResult(r) {
  return {
    id: r.id ?? r.cluster_id ?? null,
    type: r.type ?? null,
    caseName: r.caseName ?? r.case_name ?? null,
    court: r.court ?? r.court_id ?? null,
    dateFiled: r.dateFiled ?? r.date_filed ?? null,
    citation: Array.isArray(r.citation) ? r.citation : r.citation ? [r.citation] : [],
    snippet: r.snippet ?? null,
    absoluteUrl: r.absolute_url ?? null,
  };
}

function shapeOpinion(o) {
  if (o == null || typeof o !== "object") {
    throw new AdapterError("getOpinion: unexpected payload", { details: { got: typeof o } });
  }
  return {
    id: o.id ?? null,
    type: o.type ?? null,
    cluster: o.cluster ?? null,
    author: o.author_str ?? o.author ?? null,
    perCuriam: Boolean(o.per_curiam),
    plainText: o.plain_text ?? null,
    html: o.html ?? o.html_with_citations ?? null,
    downloadUrl: o.download_url ?? null,
    absoluteUrl: o.absolute_url ?? null,
  };
}

function shapeDocket(d) {
  if (d == null || typeof d !== "object") {
    throw new AdapterError("getDocket: unexpected payload", { details: { got: typeof d } });
  }
  return {
    id: d.id ?? null,
    caseName: d.case_name ?? null,
    court: d.court ?? d.court_id ?? null,
    docketNumber: d.docket_number ?? null,
    dateFiled: d.date_filed ?? null,
    dateTerminated: d.date_terminated ?? null,
    natureOfSuit: d.nature_of_suit ?? null,
    absoluteUrl: d.absolute_url ?? null,
  };
}

function courtlistenerFixtureName(url) {
  if (url.includes("/search/")) return "courtlistener-search";
  if (url.includes("/opinions/")) return "courtlistener-opinion";
  if (url.includes("/dockets/")) return "courtlistener-docket";
  return null;
}
