// openstates.mjs — typed Open States / Plural v3 client (SB-B2 / BB2-8).
//
// Open States (the Plural v3 API, https://v3.openstates.org) exposes US STATE
// legislators ("people") and STATE bills/resolutions across all 50 states +
// DC + territories. This adapter covers the two access shapes every consumer
// needs:
//   - search      : query people/bills by jurisdiction + free text
//   - fetchById    : resolve one bill (by OCD bill id) or one legislator
//
// Wired through the shared base layer (../base.mjs): token-bucket rate limit,
// TTL cache, retrying fetch with full-jitter backoff, typed errors, and a
// fixture mode that serves recorded JSON for fully-offline tests.
//
// API KEY: Open States requires a key, sent as the `X-API-KEY` header (per
// their docs). It is read from env (OPENSTATES_API_KEY) with a documented
// fallback: when no key and no fixtureMode is set, calls throw a typed
// AdapterError telling the caller to set the env var or use fixtureMode. Tests
// run exclusively in fixtureMode and need no key.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const OPENSTATES_BASE_URL = "https://v3.openstates.org";
// Open States authenticates via this header (docs: openstates.org/api/v3/).
const API_KEY_HEADER = "X-API-KEY";
// Env var consumers set to provide their key (documented fallback below).
export const OPENSTATES_API_KEY_ENV = "OPENSTATES_API_KEY";

export class OpenStatesClient {
  constructor({
    baseUrl = OPENSTATES_BASE_URL,
    // Default: pull the key from env so callers never hard-code it. Pass
    // apiKey explicitly to override.
    apiKey = process.env[OPENSTATES_API_KEY_ENV] ?? null,
    fixtureMode = false,
    // Open States free tier is ~1 req/sec, 250/day. Stay conservative.
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null, // inject a pre-built HttpClient (tests do this)
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    this.fixtureMode = fixtureMode;
    const defaultHeaders = apiKey ? { [API_KEY_HEADER]: apiKey } : {};
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        defaultHeaders,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => openStatesFixtureName(url),
        ...httpOpts,
      });
  }

  // Guard: when not in fixture mode and no key is configured, fail loudly with
  // a typed, actionable error rather than firing an unauthenticated request.
  _requireAuth() {
    if (this.fixtureMode || this.http.fixtureMode) return;
    if (!this.apiKey) {
      throw new AdapterError(
        `Open States API key required: set ${OPENSTATES_API_KEY_ENV} or pass { apiKey }, or use { fixtureMode: true }`,
        { details: { env: OPENSTATES_API_KEY_ENV } }
      );
    }
  }

  // GET /bills?jurisdiction=&q=&session=&page=&per_page=
  // Search STATE bills. Returns { results: [shapedBill], pagination }.
  async searchBills({ jurisdiction, query, session, page = 1, perPage = 20, sort } = {}) {
    this._requireAuth();
    if (!jurisdiction && !query) {
      throw new AdapterError("searchBills requires at least { jurisdiction } or { query }");
    }
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (jurisdiction) params.set("jurisdiction", String(jurisdiction));
    if (query) params.set("q", String(query));
    if (session) params.set("session", String(session));
    if (sort) params.set("sort", String(sort));

    const raw = await this.http.getJson(`/bills?${params.toString()}`, {
      fixture: "legal-openstates-bills-search",
    });
    return shapePage(raw, shapeBill);
  }

  // GET /bills/{openstates_bill_id}  e.g. ocd-bill/abc-123  -> one shaped bill.
  // `id` may also be passed as the "{jurisdiction}/{session}/{identifier}" form
  // Open States accepts; we URL-encode it as a single path segment.
  async fetchBillById(id) {
    this._requireAuth();
    if (!id) throw new AdapterError("fetchBillById requires an id");
    const raw = await this.http.getJson(`/bills/${encodeURIComponent(String(id))}`, {
      fixture: "legal-openstates-bill",
    });
    return shapeBill(raw);
  }

  // GET /people?jurisdiction=&name=&page=&per_page=
  // Search STATE legislators. Returns { results: [shapedPerson], pagination }.
  async searchLegislators({ jurisdiction, name, page = 1, perPage = 20 } = {}) {
    this._requireAuth();
    if (!jurisdiction && !name) {
      throw new AdapterError("searchLegislators requires { jurisdiction } or { name }");
    }
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (jurisdiction) params.set("jurisdiction", String(jurisdiction));
    if (name) params.set("name", String(name));

    const raw = await this.http.getJson(`/people?${params.toString()}`, {
      fixture: "legal-openstates-people-search",
    });
    return shapePage(raw, shapePerson);
  }

  // GET /people/{ocd-person/...}  -> one shaped legislator.
  async fetchLegislatorById(id) {
    this._requireAuth();
    if (!id) throw new AdapterError("fetchLegislatorById requires an id");
    const raw = await this.http.getJson(`/people/${encodeURIComponent(String(id))}`, {
      fixture: "legal-openstates-person",
    });
    return shapePerson(raw);
  }
}

// ---- shaping / typing helpers -------------------------------------------

// Open States list endpoints return { results: [...], pagination: {...} }.
function shapePage(raw, shapeItem) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("Open States: unexpected payload", { details: { got: typeof raw } });
  }
  const results = Array.isArray(raw.results) ? raw.results : [];
  const p = raw.pagination ?? {};
  return {
    results: results.map(shapeItem),
    pagination: {
      page: p.page ?? null,
      perPage: p.per_page ?? null,
      maxPage: p.max_page ?? null,
      totalItems: p.total_items ?? null,
    },
    raw,
  };
}

function shapeBill(b) {
  if (b == null || typeof b !== "object") {
    throw new AdapterError("Open States bill: unexpected payload", { details: { got: typeof b } });
  }
  return {
    id: b.id ?? null,
    identifier: b.identifier ?? null,
    title: b.title ?? null,
    jurisdiction: b.jurisdiction?.name ?? b.jurisdiction ?? null,
    session: b.session ?? null,
    classification: Array.isArray(b.classification) ? b.classification : [],
    subject: Array.isArray(b.subject) ? b.subject : [],
    firstActionDate: b.first_action_date ?? null,
    latestActionDate: b.latest_action_date ?? null,
    latestActionDescription: b.latest_action_description ?? null,
    sponsors: Array.isArray(b.sponsorships)
      ? b.sponsorships.map((s) => ({ name: s.name ?? null, classification: s.classification ?? null, primary: !!s.primary }))
      : [],
    openstatesUrl: b.openstates_url ?? null,
    sources: Array.isArray(b.sources) ? b.sources.map((s) => s.url).filter(Boolean) : [],
  };
}

function shapePerson(p) {
  if (p == null || typeof p !== "object") {
    throw new AdapterError("Open States person: unexpected payload", { details: { got: typeof p } });
  }
  return {
    id: p.id ?? null,
    name: p.name ?? null,
    party: p.party ?? (Array.isArray(p.party) ? p.party[0]?.name : null) ?? null,
    jurisdiction: p.jurisdiction?.name ?? p.jurisdiction ?? null,
    currentRole: p.current_role
      ? {
          title: p.current_role.title ?? null,
          org: p.current_role.org_classification ?? null,
          district: p.current_role.district ?? null,
        }
      : null,
    email: p.email ?? null,
    openstatesUrl: p.openstates_url ?? null,
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
function openStatesFixtureName(url) {
  // Order matters: match the by-id detail routes before the list routes.
  if (/\/bills\/[^?]+/.test(url)) return "legal-openstates-bill";
  if (url.includes("/bills")) return "legal-openstates-bills-search";
  if (/\/people\/[^?]+/.test(url)) return "legal-openstates-person";
  if (url.includes("/people")) return "legal-openstates-people-search";
  return null;
}
