// govinfo.mjs — typed govinfo.gov API client (SoapBox BB2-3).
//
// READ-ONLY. The GPO govinfo API serves authenticated federal documents:
// the US Code (USCODE), CFR, bills (BILLS), the Federal Register (FR), etc.
//   - GET /collections/{collection}/{startDate}/{endDate}?...  -> package list
//   - GET /search  (POST in the live API)  -> we use the GET collections + the
//        published search via the documented query params
//   - GET /packages/{packageId}/summary    -> one package's metadata
//   - GET /packages/{packageId}/granules    -> granules (sub-documents)
//
// Wired through the shared adapter base: rate-limited, TTL-cached, retrying,
// typed errors, fixture mode. govinfo requires a DATA.gov api_key for live use;
// we read it from env (GOVINFO_API_KEY, fallback DATA_GOV_API_KEY, then the
// documented public "DEMO_KEY"). It is sent as the ?api_key= query param, never
// hardcoded. In fixture mode no key is needed.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LegalHttpClient, apiKeyFromEnv } from "./legal-base.mjs";

export const GOVINFO_BASE_URL = "https://api.govinfo.gov";

export class GovInfoClient {
  constructor({
    baseUrl = GOVINFO_BASE_URL,
    // documented fallback chain: GOVINFO_API_KEY -> DATA_GOV_API_KEY -> "DEMO_KEY"
    apiKey = apiKeyFromEnv("GOVINFO_API_KEY") ?? apiKeyFromEnv("DATA_GOV_API_KEY") ?? "DEMO_KEY",
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    this.http =
      http ??
      new LegalHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => govinfoFixtureName(url),
        ...httpOpts,
      });
  }

  _withKey(params) {
    if (this.apiKey) params.set("api_key", this.apiKey);
    return params;
  }

  // GET /collections/{collection}/{startDate}/{endDate} -> package list.
  // e.g. collection="BILLS", dates ISO "2024-01-01T00:00:00Z".
  async search({ collection, startDate, endDate, pageSize = 20, offsetMark = "*" } = {}) {
    if (!collection) throw new AdapterError("search: collection is required");
    if (!startDate || !endDate) throw new AdapterError("search: startDate and endDate are required");
    const params = this._withKey(
      new URLSearchParams({
        pageSize: String(pageSize),
        offsetMark: String(offsetMark),
      }),
    );
    const path = `/collections/${encodeURIComponent(collection)}/${encodeURIComponent(startDate)}/${encodeURIComponent(endDate)}?${params.toString()}`;
    const raw = await this.http.getJson(path, { fixture: "govinfo-collection" });
    return shapeCollection(raw);
  }

  // GET /packages/{packageId}/summary -> one package's metadata.
  async getPackage(packageId) {
    if (!packageId) throw new AdapterError("getPackage: packageId is required");
    const params = this._withKey(new URLSearchParams());
    const path = `/packages/${encodeURIComponent(packageId)}/summary?${params.toString()}`;
    const raw = await this.http.getJson(path, { fixture: "govinfo-package" });
    return shapePackage(raw);
  }

  // GET /packages/{packageId}/granules -> granule list (paginated).
  async getGranules(packageId, { pageSize = 20, offsetMark = "*" } = {}) {
    if (!packageId) throw new AdapterError("getGranules: packageId is required");
    const params = this._withKey(
      new URLSearchParams({ pageSize: String(pageSize), offsetMark: String(offsetMark) }),
    );
    const path = `/packages/${encodeURIComponent(packageId)}/granules?${params.toString()}`;
    const raw = await this.http.getJson(path, { fixture: "govinfo-granules" });
    return shapeGranules(raw);
  }
}

// ---- shaping helpers ------------------------------------------------------

// govinfo paginates with { count, offsetMark, nextPage, packages: [...] }.
function shapeCollection(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.packages)) {
    throw new AdapterError("collection: expected { count, packages: [...] }", {
      details: { got: typeof raw },
    });
  }
  return {
    count: raw.count ?? null,
    nextPage: raw.nextPage ?? null,
    offsetMark: raw.offsetMark ?? null,
    results: raw.packages.map((p) => ({
      packageId: p.packageId ?? null,
      title: p.title ?? null,
      docClass: p.docClass ?? null,
      dateIssued: p.dateIssued ?? null,
      lastModified: p.lastModified ?? null,
      packageLink: p.packageLink ?? null,
    })),
  };
}

function shapePackage(p) {
  if (p == null || typeof p !== "object") {
    throw new AdapterError("getPackage: unexpected payload", { details: { got: typeof p } });
  }
  return {
    packageId: p.packageId ?? null,
    collectionCode: p.collectionCode ?? null,
    title: p.title ?? null,
    category: p.category ?? null,
    dateIssued: p.dateIssued ?? null,
    congress: p.congress ?? null,
    download: p.download ?? null,
    branch: p.branch ?? null,
  };
}

function shapeGranules(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.granules)) {
    throw new AdapterError("getGranules: expected { count, granules: [...] }", {
      details: { got: typeof raw },
    });
  }
  return {
    count: raw.count ?? null,
    offsetMark: raw.offsetMark ?? null,
    nextPage: raw.nextPage ?? null,
    results: raw.granules.map((g) => ({
      granuleId: g.granuleId ?? null,
      title: g.title ?? null,
      granuleClass: g.granuleClass ?? null,
      granuleLink: g.granuleLink ?? null,
    })),
  };
}

function govinfoFixtureName(url) {
  if (url.includes("/granules")) return "govinfo-granules";
  if (url.includes("/packages/")) return "govinfo-package";
  if (url.includes("/collections/")) return "govinfo-collection";
  return null;
}
