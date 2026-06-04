// congress-gov.mjs — typed Congress.gov API client (SB-B2 / BB2-10).
//
// The Congress.gov API (https://api.congress.gov/v3) is the official source for
// US FEDERAL legislation: bills, members of Congress, and nominations. (It is
// the federal counterpart to the state-level Open States / LegiScan adapters in
// this directory.) This adapter covers the search + fetch-by-id shapes for the
// three entity families the SoapBox legal layer needs:
//   - bills        : searchBills / fetchBillById(congress, type, number)
//   - members      : searchMembers / fetchMemberById(bioguideId)
//   - nominations  : searchNominations / fetchNominationById(congress, number)
//
// Wired through the shared base layer (../base.mjs): token-bucket rate limit,
// TTL cache, retrying fetch with full-jitter backoff, typed errors, and a
// fixture mode that serves recorded JSON for fully-offline tests.
//
// API KEY: Congress.gov requires a key passed as the `api_key` query parameter
// (per their docs; data.gov-issued key). Read from env (CONGRESS_GOV_API_KEY)
// with a documented fallback: when no key and not in fixtureMode, calls throw a
// typed AdapterError. Tests run exclusively in fixtureMode and need no key.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const CONGRESS_GOV_BASE_URL = "https://api.congress.gov/v3";
// Env var consumers set to provide their key (documented fallback below).
export const CONGRESS_GOV_API_KEY_ENV = "CONGRESS_GOV_API_KEY";

export class CongressGovClient {
  constructor({
    baseUrl = CONGRESS_GOV_BASE_URL,
    apiKey = process.env[CONGRESS_GOV_API_KEY_ENV] ?? null,
    fixtureMode = false,
    // Congress.gov / data.gov default rate limit is ~1000 req/hour. Stay polite.
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.apiKey = apiKey;
    this.fixtureMode = fixtureMode;
    this.http =
      http ??
      new HttpClient({
        baseUrl,
        // Congress.gov returns XML by default; force JSON via Accept + format.
        defaultHeaders: { Accept: "application/json" },
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => congressFixtureName(url),
        ...httpOpts,
      });
  }

  _requireAuth() {
    if (this.fixtureMode || this.http.fixtureMode) return;
    if (!this.apiKey) {
      throw new AdapterError(
        `Congress.gov API key required: set ${CONGRESS_GOV_API_KEY_ENV} or pass { apiKey }, or use { fixtureMode: true }`,
        { details: { env: CONGRESS_GOV_API_KEY_ENV } }
      );
    }
  }

  // Compose the query string with format=json, paging, and (live) the api_key.
  _query(extra = {}) {
    const params = new URLSearchParams({ format: "json" });
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) params.set(k, String(v));
    }
    if (this.apiKey && !(this.fixtureMode || this.http.fixtureMode)) {
      params.set("api_key", this.apiKey);
    }
    return params;
  }

  // ---- bills -------------------------------------------------------------

  // GET /bill[/{congress}][/{type}]  — list/search bills. `query` does a
  // text filter where supported; congress + type narrow the set.
  async searchBills({ congress, billType, query, offset = 0, limit = 20, sort } = {}) {
    this._requireAuth();
    let path = "/bill";
    if (congress) path += `/${encodeURIComponent(String(congress))}`;
    if (congress && billType) path += `/${encodeURIComponent(String(billType).toLowerCase())}`;
    const params = this._query({ offset, limit, q: query, sort });
    const raw = await this.http.getJson(`${path}?${params.toString()}`, {
      fixture: "legal-congress-bills-search",
    });
    return shapeList(raw, "bills", shapeBillSummary);
  }

  // GET /bill/{congress}/{type}/{number} — one bill's full detail.
  async fetchBillById({ congress, billType, number } = {}) {
    this._requireAuth();
    if (!congress || !billType || number == null) {
      throw new AdapterError("fetchBillById requires { congress, billType, number }");
    }
    const path = `/bill/${encodeURIComponent(String(congress))}/${encodeURIComponent(
      String(billType).toLowerCase()
    )}/${encodeURIComponent(String(number))}`;
    const params = this._query();
    const raw = await this.http.getJson(`${path}?${params.toString()}`, {
      fixture: "legal-congress-bill",
    });
    return shapeBillDetail(unwrapOne(raw, "bill"));
  }

  // ---- members -----------------------------------------------------------

  // GET /member — list/search members of Congress.
  async searchMembers({ congress, stateCode, query, offset = 0, limit = 20 } = {}) {
    this._requireAuth();
    let path = "/member";
    if (congress) path += `/congress/${encodeURIComponent(String(congress))}`;
    const params = this._query({ offset, limit, q: query, currentMember: undefined });
    if (stateCode) params.set("stateCode", String(stateCode).toUpperCase());
    const raw = await this.http.getJson(`${path}?${params.toString()}`, {
      fixture: "legal-congress-members-search",
    });
    return shapeList(raw, "members", shapeMember);
  }

  // GET /member/{bioguideId} — one member's detail.
  async fetchMemberById(bioguideId) {
    this._requireAuth();
    if (!bioguideId) throw new AdapterError("fetchMemberById requires a bioguideId");
    const params = this._query();
    const raw = await this.http.getJson(
      `/member/${encodeURIComponent(String(bioguideId))}?${params.toString()}`,
      { fixture: "legal-congress-member" }
    );
    return shapeMember(unwrapOne(raw, "member"));
  }

  // ---- nominations -------------------------------------------------------

  // GET /nomination[/{congress}] — list/search presidential nominations.
  async searchNominations({ congress, offset = 0, limit = 20 } = {}) {
    this._requireAuth();
    let path = "/nomination";
    if (congress) path += `/${encodeURIComponent(String(congress))}`;
    const params = this._query({ offset, limit });
    const raw = await this.http.getJson(`${path}?${params.toString()}`, {
      fixture: "legal-congress-nominations-search",
    });
    return shapeList(raw, "nominations", shapeNomination);
  }

  // GET /nomination/{congress}/{number} — one nomination's detail.
  async fetchNominationById({ congress, number } = {}) {
    this._requireAuth();
    if (!congress || number == null) {
      throw new AdapterError("fetchNominationById requires { congress, number }");
    }
    const path = `/nomination/${encodeURIComponent(String(congress))}/${encodeURIComponent(
      String(number)
    )}`;
    const params = this._query();
    const raw = await this.http.getJson(`${path}?${params.toString()}`, {
      fixture: "legal-congress-nomination",
    });
    return shapeNomination(unwrapOne(raw, "nomination"));
  }
}

// ---- shaping / typing helpers -------------------------------------------

// Congress.gov list responses are { <key>: [...], pagination: {...} }.
function shapeList(raw, key, shapeItem) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("Congress.gov: unexpected payload", { details: { got: typeof raw } });
  }
  const items = Array.isArray(raw[key]) ? raw[key] : [];
  const p = raw.pagination ?? {};
  return {
    results: items.map(shapeItem),
    pagination: { count: p.count ?? null, next: p.next ?? null, prev: p.prev ?? null },
    raw,
  };
}

// Detail responses wrap a single entity under a named key.
function unwrapOne(raw, key) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("Congress.gov: unexpected payload", { details: { got: typeof raw } });
  }
  const one = raw[key];
  if (one == null) {
    throw new AdapterError(`Congress.gov: missing '${key}' in payload`, {
      details: { keys: Object.keys(raw) },
    });
  }
  return one;
}

function shapeBillSummary(b) {
  return {
    congress: b.congress ?? null,
    type: b.type ?? null,
    number: b.number ?? null,
    title: b.title ?? null,
    originChamber: b.originChamber ?? null,
    latestAction: b.latestAction
      ? { date: b.latestAction.actionDate ?? null, text: b.latestAction.text ?? null }
      : null,
    updateDate: b.updateDate ?? null,
    url: b.url ?? null,
  };
}

function shapeBillDetail(b) {
  const base = shapeBillSummary(b);
  return {
    ...base,
    introducedDate: b.introducedDate ?? null,
    policyArea: b.policyArea?.name ?? null,
    sponsors: Array.isArray(b.sponsors)
      ? b.sponsors.map((s) => ({ bioguideId: s.bioguideId ?? null, fullName: s.fullName ?? null, party: s.party ?? null, state: s.state ?? null }))
      : [],
    cosponsorCount: b.cosponsors?.count ?? null,
    subjectsCount: b.subjects?.count ?? null,
    textVersionsUrl: b.textVersions?.url ?? null,
  };
}

function shapeMember(m) {
  if (m == null || typeof m !== "object") {
    throw new AdapterError("Congress.gov member: unexpected payload", { details: { got: typeof m } });
  }
  return {
    bioguideId: m.bioguideId ?? null,
    name: m.name ?? m.directOrderName ?? null,
    party: m.partyName ?? m.party ?? null,
    state: m.state ?? null,
    district: m.district ?? null,
    chamber: m.terms?.item?.[0]?.chamber ?? m.chamber ?? null,
    url: m.url ?? null,
  };
}

function shapeNomination(n) {
  if (n == null || typeof n !== "object") {
    throw new AdapterError("Congress.gov nomination: unexpected payload", { details: { got: typeof n } });
  }
  return {
    congress: n.congress ?? null,
    number: n.number ?? null,
    citation: n.citation ?? null,
    description: n.description ?? null,
    receivedDate: n.receivedDate ?? null,
    organization: n.organization ?? null,
    latestAction: n.latestAction
      ? { date: n.latestAction.actionDate ?? null, text: n.latestAction.text ?? null }
      : null,
    url: n.url ?? null,
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
// Order matters: detail (by-id) routes have an extra path segment beyond the
// list routes, so test the more-specific patterns first.
function congressFixtureName(url) {
  const u = url.split("?")[0];
  // /bill/{congress}/{type}/{number}
  if (/\/bill\/[^/]+\/[^/]+\/[^/]+$/.test(u)) return "legal-congress-bill";
  if (/\/bill(\/|$)/.test(u)) return "legal-congress-bills-search";
  // /member/{bioguideId}  (single trailing segment that is NOT "congress")
  if (/\/member\/(?!congress\b)[^/]+$/.test(u)) return "legal-congress-member";
  if (/\/member(\/|$)/.test(u)) return "legal-congress-members-search";
  // /nomination/{congress}/{number}
  if (/\/nomination\/[^/]+\/[^/]+$/.test(u)) return "legal-congress-nomination";
  if (/\/nomination(\/|$)/.test(u)) return "legal-congress-nominations-search";
  return null;
}
