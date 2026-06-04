// recap.mjs — typed RECAP Archive (read-only) client (SoapBox BB2-7).
//
// READ-ONLY. RECAP is the Free Law Project archive of PACER federal court
// documents, exposed through CourtListener's REST API v4:
//   - GET /api/rest/v4/search/?type=r&q=...   -> search RECAP dockets/docs
//   - GET /api/rest/v4/dockets/{id}/          -> one docket
//   - GET /api/rest/v4/docket-entries/?docket={id}  -> entries (paginated)
//   - GET /api/rest/v4/recap-documents/{id}/  -> one archived document's metadata
//
// ⚠️ SCOPE NOTE: This adapter ONLY reads the free, public RECAP Archive. It does
// NOT touch paid PACER. Live PACER fetch/purchase (the CourtListener `recap-fetch`
// endpoint and any PACER credential flow) is OUT OF SCOPE here — RECAP Archive
// read-only only. Do not add PACER-purchase calls to this module.
//
// Wired through the shared adapter base: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. An optional CourtListener token (env CL_API_TOKEN,
// sent as "Authorization: Token <key>") only raises the read rate limit; no key
// is required and none is hardcoded.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient, apiKeyFromEnv } from "./legal-base.mjs";

export const RECAP_BASE_URL = "https://www.courtlistener.com/api/rest/v4";

export class RecapClient {
  constructor({
    baseUrl = RECAP_BASE_URL,
    apiKey = apiKeyFromEnv("CL_API_TOKEN"), // documented fallback: null (key-less read)
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
        fixtureResolver: (url) => recapFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /search/?type=r&q=... -> RECAP search (DRF page envelope).
  async search({ q, court = null, page = 1 } = {}) {
    if (!q || !String(q).trim()) throw new AdapterError("search: q is required");
    const params = new URLSearchParams({ type: "r", q: String(q).trim(), page: String(page) });
    if (court) params.set("court", String(court));
    const raw = await this.http.getJson(`/search/?${params.toString()}`, { fixture: "recap-search" });
    return shapePage(raw, shapeRecapResult);
  }

  // GET /docket-entries/?docket={id} -> paginated docket entries.
  async getDocketEntries(docketId, { page = 1 } = {}) {
    if (docketId == null) throw new AdapterError("getDocketEntries: docketId is required");
    const params = new URLSearchParams({ docket: String(docketId), page: String(page) });
    const raw = await this.http.getJson(`/docket-entries/?${params.toString()}`, {
      fixture: "recap-docket-entries",
    });
    return shapePage(raw, shapeDocketEntry);
  }

  // GET /recap-documents/{id}/ -> one archived document's metadata.
  async getDocument(id) {
    if (id == null) throw new AdapterError("getDocument: id is required");
    const raw = await this.http.getJson(`/recap-documents/${encodeURIComponent(id)}/`, {
      fixture: "recap-document",
    });
    return shapeRecapDocument(raw);
  }
}

// ---- shaping helpers ------------------------------------------------------

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

function shapeRecapResult(r) {
  return {
    docketId: r.docket_id ?? r.id ?? null,
    caseName: r.caseName ?? r.case_name ?? null,
    court: r.court ?? r.court_id ?? null,
    docketNumber: r.docketNumber ?? r.docket_number ?? null,
    dateFiled: r.dateFiled ?? r.date_filed ?? null,
    absoluteUrl: r.absolute_url ?? null,
  };
}

function shapeDocketEntry(e) {
  return {
    id: e.id ?? null,
    docket: e.docket ?? null,
    entryNumber: e.entry_number ?? null,
    dateFiled: e.date_filed ?? null,
    description: e.description ?? null,
    recapDocuments: Array.isArray(e.recap_documents)
      ? e.recap_documents.map((d) => ({
          id: d.id ?? null,
          documentNumber: d.document_number ?? null,
          isAvailable: Boolean(d.is_available),
          filepathLocal: d.filepath_local ?? null,
          pageCount: d.page_count ?? null,
        }))
      : [],
  };
}

function shapeRecapDocument(d) {
  if (d == null || typeof d !== "object") {
    throw new AdapterError("getDocument: unexpected payload", { details: { got: typeof d } });
  }
  return {
    id: d.id ?? null,
    docketEntry: d.docket_entry ?? null,
    documentNumber: d.document_number ?? null,
    isAvailable: Boolean(d.is_available),
    pageCount: d.page_count ?? null,
    filepathLocal: d.filepath_local ?? null,
    plainText: d.plain_text ?? null,
    absoluteUrl: d.absolute_url ?? null,
  };
}

function recapFixtureName(url) {
  if (url.includes("/docket-entries/")) return "recap-docket-entries";
  if (url.includes("/recap-documents/")) return "recap-document";
  if (url.includes("/search/")) return "recap-search";
  return null;
}
