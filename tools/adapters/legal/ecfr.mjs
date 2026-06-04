// ecfr.mjs — typed eCFR API client (SoapBox BB2-5).
//
// READ-ONLY. The Electronic Code of Federal Regulations API (ecfr.gov) is a
// free, key-less government API:
//   - GET /api/search/v1/results?query=...        -> full-text search
//   - GET /api/versioner/v1/structure/{date}/title-{n}.json -> title structure
//   - GET /api/versioner/v1/full/{date}/title-{n}.json      -> full content (XML)
//   - GET /api/admin/v1/agencies.json             -> agency list
//
// Wired through the shared adapter base: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. No API key (the eCFR API is fully public) — there
// is nothing to read from env.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient } from "./legal-base.mjs";

export const ECFR_BASE_URL = "https://www.ecfr.gov";

export class ECFRClient {
  constructor({
    baseUrl = ECFR_BASE_URL,
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
        fixtureResolver: (url) => ecfrFixtureName(url),
        ...httpOpts,
      });
  }

  // GET /api/search/v1/results?query=...  -> { results: [...], meta }.
  async search({ query, perPage = 20, page = 1, agencySlugs = null } = {}) {
    if (!query || !String(query).trim()) throw new AdapterError("search: query is required");
    const params = new URLSearchParams({
      query: String(query).trim(),
      per_page: String(perPage),
      page: String(page),
    });
    if (agencySlugs) {
      for (const slug of [].concat(agencySlugs)) params.append("agency_slugs[]", String(slug));
    }
    const raw = await this.http.getJson(`/api/search/v1/results?${params.toString()}`, {
      fixture: "ecfr-search",
    });
    return shapeSearch(raw);
  }

  // GET /api/versioner/v1/structure/{date}/title-{n}.json -> nested structure.
  async getTitleStructure(titleNumber, { date = "current" } = {}) {
    if (titleNumber == null) throw new AdapterError("getTitleStructure: titleNumber is required");
    const d = date === "current" ? todayISO() : String(date);
    const raw = await this.http.getJson(
      `/api/versioner/v1/structure/${encodeURIComponent(d)}/title-${encodeURIComponent(titleNumber)}.json`,
      { fixture: "ecfr-structure" },
    );
    return shapeStructure(raw);
  }

  // GET /api/admin/v1/agencies.json -> { agencies: [...] }.
  async getAgencies() {
    const raw = await this.http.getJson(`/api/admin/v1/agencies.json`, { fixture: "ecfr-agencies" });
    if (raw == null || !Array.isArray(raw.agencies)) {
      throw new AdapterError("getAgencies: expected { agencies: [...] }", { details: { got: typeof raw } });
    }
    return raw.agencies.map((a) => ({
      name: a.name ?? null,
      shortName: a.short_name ?? null,
      slug: a.slug ?? null,
      cfrReferences: Array.isArray(a.cfr_references) ? a.cfr_references : [],
    }));
  }
}

// ---- shaping helpers ------------------------------------------------------

function shapeSearch(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.results)) {
    throw new AdapterError("search: expected { results: [...], meta }", { details: { got: typeof raw } });
  }
  const meta = raw.meta ?? {};
  return {
    total: meta.total_count ?? meta.total ?? raw.results.length,
    currentPage: meta.current_page ?? null,
    totalPages: meta.total_pages ?? null,
    results: raw.results.map((r) => ({
      hierarchy: r.hierarchy ?? null,
      headingHierarchy: r.headings ?? r.hierarchy_headings ?? null,
      fullTextExcerpt: r.full_text_excerpt ?? null,
      score: r.score ?? null,
      structureIndex: r.structure_index ?? null,
      startsOn: r.starts_on ?? null,
      endsOn: r.ends_on ?? null,
    })),
  };
}

function shapeStructure(node) {
  if (node == null || typeof node !== "object") {
    throw new AdapterError("getTitleStructure: unexpected payload", { details: { got: typeof node } });
  }
  const shape = (n) => ({
    type: n.type ?? null,
    label: n.label ?? null,
    identifier: n.identifier ?? null,
    labelLevel: n.label_level ?? null,
    reserved: Boolean(n.reserved),
    children: Array.isArray(n.children) ? n.children.map(shape) : [],
  });
  return shape(node);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ecfrFixtureName(url) {
  if (url.includes("/search/v1/results")) return "ecfr-search";
  if (url.includes("/versioner/v1/structure/")) return "ecfr-structure";
  if (url.includes("/agencies")) return "ecfr-agencies";
  return null;
}
