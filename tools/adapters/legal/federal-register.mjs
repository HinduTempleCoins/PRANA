// federal-register.mjs — typed Federal Register API client (SoapBox BB2-6).
//
// READ-ONLY. The Federal Register API (federalregister.gov) is a free, key-less
// government API for the daily journal of the US federal government:
//   - GET /api/v1/documents.json?conditions[term]=...  -> document search
//   - GET /api/v1/documents/{document_number}.json     -> one document
//   - GET /api/v1/agencies.json                        -> agency list
//
// Wired through the shared adapter base: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. No API key (the API is fully public) — nothing is
// read from env.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient } from "./legal-base.mjs";

export const FEDERAL_REGISTER_BASE_URL = "https://www.federalregister.gov";

export class FederalRegisterClient {
  constructor({
    baseUrl = FEDERAL_REGISTER_BASE_URL,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.http =
      http ??
      new LegalHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => federalRegisterFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /api/v1/documents.json?conditions[term]=...&per_page=...&page=...
  // Returns { count, totalPages, nextPageUrl, results: [typed docs] }.
  async search({ term, perPage = 20, page = 1, type = null } = {}) {
    if (!term || !String(term).trim()) throw new AdapterError("search: term is required");
    const params = new URLSearchParams({
      "conditions[term]": String(term).trim(),
      per_page: String(perPage),
      page: String(page),
    });
    if (type) {
      for (const t of [].concat(type)) params.append("conditions[type][]", String(t));
    }
    const raw = await this.http.getJson(`/api/v1/documents.json?${params.toString()}`, {
      fixture: "federal-register-search",
    });
    return shapeSearch(raw);
  }

  // GET /api/v1/documents/{document_number}.json -> one document.
  async getDocument(documentNumber) {
    if (!documentNumber) throw new AdapterError("getDocument: documentNumber is required");
    const raw = await this.http.getJson(
      `/api/v1/documents/${encodeURIComponent(documentNumber)}.json`,
      { fixture: "federal-register-document" },
    );
    return shapeDocument(raw);
  }
}

// ---- shaping helpers ------------------------------------------------------

function shapeSearch(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.results)) {
    throw new AdapterError("search: expected { count, results: [...] }", { details: { got: typeof raw } });
  }
  return {
    count: raw.count ?? null,
    totalPages: raw.total_pages ?? null,
    nextPageUrl: raw.next_page_url ?? null,
    results: raw.results.map(shapeDocument),
  };
}

function shapeDocument(d) {
  if (d == null || typeof d !== "object") {
    throw new AdapterError("document: unexpected payload", { details: { got: typeof d } });
  }
  return {
    documentNumber: d.document_number ?? null,
    title: d.title ?? null,
    type: d.type ?? null,
    abstract: d.abstract ?? null,
    publicationDate: d.publication_date ?? null,
    agencies: Array.isArray(d.agencies)
      ? d.agencies.map((a) => (typeof a === "string" ? a : a?.name ?? null)).filter(Boolean)
      : [],
    htmlUrl: d.html_url ?? null,
    pdfUrl: d.pdf_url ?? null,
    citation: d.citation ?? null,
  };
}

function federalRegisterFixtureName(url) {
  if (/\/documents\/[^/]+\.json/.test(url)) return "federal-register-document";
  if (url.includes("/documents.json")) return "federal-register-search";
  return null;
}
