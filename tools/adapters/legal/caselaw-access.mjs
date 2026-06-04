// caselaw-access.mjs — typed Caselaw Access Project client (SoapBox BB2-2).
//
// READ-ONLY. The Harvard Law School / LIL Caselaw Access Project (CAP) opened
// ~6.7M decisions. The legacy api.case.law REST API was retired in 2024 and the
// bulk corpus moved to static.case.law; the long-lived public surface for
// programmatic search remains the CAP-style REST shape, which this client
// targets:
//   - GET /v1/cases/?search=...   -> full-text search (DRF page envelope)
//   - GET /v1/cases/{id}/         -> one case (metadata + optional casebody)
//
// Wired through the shared adapter base: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. CAP read access is key-less for metadata; an
// optional token (env CAP_API_KEY, sent as "Authorization: Token <key>") raises
// limits / unlocks full case text where applicable. No key hardcoded.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient, apiKeyFromEnv } from "./legal-base.mjs";

export const CASELAW_BASE_URL = "https://api.case.law/v1";

export class CaselawAccessClient {
  constructor({
    baseUrl = CASELAW_BASE_URL,
    apiKey = apiKeyFromEnv("CAP_API_KEY"), // documented fallback: null (key-less metadata)
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
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
        fixtureResolver: (url) => caselawFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /cases/?search=...&jurisdiction=...&page=...  -> DRF page of cases.
  async search({ search, jurisdiction = null, fullCase = false, page = 1 } = {}) {
    if (!search || !String(search).trim()) throw new AdapterError("search: search term is required");
    const params = new URLSearchParams({ search: String(search).trim(), page: String(page) });
    if (jurisdiction) params.set("jurisdiction", String(jurisdiction));
    if (fullCase) params.set("full_case", "true");
    const raw = await this.http.getJson(`/cases/?${params.toString()}`, {
      fixture: "caselaw-search",
    });
    return shapePage(raw, shapeCase);
  }

  // GET /cases/{id}/[?full_case=true] -> one case record.
  async getCase(id, { fullCase = false } = {}) {
    if (id == null) throw new AdapterError("getCase: id is required");
    const qs = fullCase ? "?full_case=true" : "";
    const raw = await this.http.getJson(`/cases/${encodeURIComponent(id)}/${qs}`, {
      fixture: "caselaw-case",
    });
    return shapeCase(raw);
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

function shapeCase(c) {
  if (c == null || typeof c !== "object") {
    throw new AdapterError("case: unexpected payload", { details: { got: typeof c } });
  }
  return {
    id: c.id ?? null,
    name: c.name ?? null,
    nameAbbreviation: c.name_abbreviation ?? null,
    decisionDate: c.decision_date ?? null,
    docketNumber: c.docket_number ?? null,
    citations: Array.isArray(c.citations)
      ? c.citations.map((x) => ({ cite: x.cite ?? null, type: x.type ?? null }))
      : [],
    court: c.court ? { id: c.court.id ?? null, name: c.court.name ?? null } : null,
    jurisdiction: c.jurisdiction
      ? { id: c.jurisdiction.id ?? null, name: c.jurisdiction.name ?? null, slug: c.jurisdiction.slug ?? null }
      : null,
    // casebody.text only present when full_case=true and access permits.
    bodyText: c.casebody?.data?.text ?? c.casebody?.text ?? null,
    frontendUrl: c.frontend_url ?? null,
  };
}

function caselawFixtureName(url) {
  // /cases/{id}/ has a trailing id segment; /cases/?search=... is the list.
  if (/\/cases\/\d+\/?/.test(url)) return "caselaw-case";
  if (url.includes("/cases/")) return "caselaw-search";
  return null;
}
