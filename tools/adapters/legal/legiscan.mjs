// legiscan.mjs — typed LegiScan client (SB-B2 / BB2-9).
//
// LegiScan (https://api.legiscan.com) tracks US STATE (and Congress) legislation
// nationwide. Its API is a single endpoint with an `op` query param selecting
// the operation. This adapter covers the search + fetch-by-id shapes:
//   - search       : op=getSearch / getSearchRaw — bills by state + query
//   - fetchById     : op=getBill — full bill detail by LegiScan bill_id
//
// Wired through the shared base layer (../base.mjs): token-bucket rate limit,
// TTL cache, retrying fetch with full-jitter backoff, typed errors, and a
// fixture mode that serves recorded JSON for fully-offline tests.
//
// API KEY: LegiScan requires a key passed as the `key` query parameter (per
// their docs). Read from env (LEGISCAN_API_KEY) with a documented fallback:
// when no key and not in fixtureMode, calls throw a typed AdapterError. Tests
// run exclusively in fixtureMode and need no key.
//
// NOTE: LegiScan always returns HTTP 200; success/failure lives in the
// `status` field of the JSON body ("OK" / "ERROR"). We map "ERROR" to a typed
// AdapterError carrying the upstream alert text.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const LEGISCAN_BASE_URL = "https://api.legiscan.com";
// Env var consumers set to provide their key (documented fallback below).
export const LEGISCAN_API_KEY_ENV = "LEGISCAN_API_KEY";

export class LegiScanClient {
  constructor({
    baseUrl = LEGISCAN_BASE_URL,
    apiKey = process.env[LEGISCAN_API_KEY_ENV] ?? null,
    fixtureMode = false,
    // LegiScan free tier is generous but capped; stay polite.
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 1 }),
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
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => legiscanFixtureName(url),
        ...httpOpts,
      });
  }

  _requireAuth() {
    if (this.fixtureMode || this.http.fixtureMode) return;
    if (!this.apiKey) {
      throw new AdapterError(
        `LegiScan API key required: set ${LEGISCAN_API_KEY_ENV} or pass { apiKey }, or use { fixtureMode: true }`,
        { details: { env: LEGISCAN_API_KEY_ENV } }
      );
    }
  }

  // Build the `/?key=&op=&...` query LegiScan expects. The key is omitted in
  // fixture mode (the resolver keys off `op`, not the secret).
  _query(op, extra = {}) {
    const params = new URLSearchParams({ op });
    if (this.apiKey && !(this.fixtureMode || this.http.fixtureMode)) {
      params.set("key", this.apiKey);
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) params.set(k, String(v));
    }
    return params;
  }

  // op=getSearch — search STATE legislation. `state` is a 2-letter code (or
  // "ALL"); `query` is the full-text query. Returns { results, summary, raw }.
  async searchBills({ state = "ALL", query, year, page = 1 } = {}) {
    this._requireAuth();
    if (!query) throw new AdapterError("searchBills requires { query }");
    const params = this._query("getSearch", { state, query, year, page });
    const raw = await this.http.getJson(`/?${params.toString()}`, {
      fixture: "legal-legiscan-search",
    });
    const data = unwrap(raw, "searchresult");
    return shapeSearch(data, raw);
  }

  // op=getBill — full detail for one LegiScan bill_id. Returns a shaped bill.
  async fetchBillById(billId) {
    this._requireAuth();
    if (billId == null || `${billId}` === "") throw new AdapterError("fetchBillById requires a billId");
    const params = this._query("getBill", { id: billId });
    const raw = await this.http.getJson(`/?${params.toString()}`, {
      fixture: "legal-legiscan-bill",
    });
    const bill = unwrap(raw, "bill");
    return shapeBill(bill);
  }
}

// ---- shaping / typing helpers -------------------------------------------

// LegiScan responses are { status: "OK"|"ERROR", <payloadKey>: {...}, alert? }.
// Map ERROR to a typed AdapterError; otherwise return the named payload.
function unwrap(raw, payloadKey) {
  if (raw == null || typeof raw !== "object") {
    throw new AdapterError("LegiScan: unexpected payload", { details: { got: typeof raw } });
  }
  if (raw.status && raw.status !== "OK") {
    const msg = raw.alert?.message ?? raw.alert ?? "LegiScan returned an error status";
    throw new AdapterError(`LegiScan error: ${msg}`, { details: { status: raw.status } });
  }
  const payload = raw[payloadKey];
  if (payload == null) {
    throw new AdapterError(`LegiScan: missing '${payloadKey}' in payload`, {
      details: { keys: Object.keys(raw) },
    });
  }
  return payload;
}

// getSearch payload: { summary: {...}, results: { "0": {...}, "1": {...} } }
// where the numeric keys are the hit list. Normalise to an array.
function shapeSearch(searchresult, raw) {
  const summary = searchresult.summary ?? {};
  const hits = [];
  for (const [k, v] of Object.entries(searchresult)) {
    if (k === "summary") continue;
    if (v && typeof v === "object" && v.bill_id != null) hits.push(shapeSearchHit(v));
  }
  return {
    results: hits,
    summary: {
      page: summary.page ?? null,
      pageTotal: summary.page_total ?? null,
      count: summary.count ?? null,
      query: summary.query ?? null,
    },
    raw,
  };
}

function shapeSearchHit(h) {
  return {
    billId: h.bill_id ?? null,
    billNumber: h.bill_number ?? null,
    title: h.title ?? null,
    state: h.state ?? null,
    relevance: h.relevance != null ? Number(h.relevance) : null,
    lastAction: h.last_action ?? null,
    lastActionDate: h.last_action_date ?? null,
    url: h.url ?? h.state_link ?? null,
  };
}

function shapeBill(b) {
  if (b == null || typeof b !== "object") {
    throw new AdapterError("LegiScan bill: unexpected payload", { details: { got: typeof b } });
  }
  return {
    billId: b.bill_id ?? null,
    billNumber: b.bill_number ?? null,
    title: b.title ?? null,
    description: b.description ?? null,
    state: b.state ?? null,
    session: b.session
      ? { sessionId: b.session.session_id ?? null, name: b.session.session_name ?? null, year: b.session.year_start ?? null }
      : null,
    status: b.status ?? null,
    statusDate: b.status_date ?? null,
    sponsors: Array.isArray(b.sponsors)
      ? b.sponsors.map((s) => ({ name: s.name ?? null, role: s.role ?? null, party: s.party ?? null, sponsorType: s.sponsor_type_id ?? null }))
      : [],
    subjects: Array.isArray(b.subjects) ? b.subjects.map((s) => s.subject_name ?? s).filter(Boolean) : [],
    history: Array.isArray(b.history)
      ? b.history.map((h) => ({ date: h.date ?? null, action: h.action ?? null, chamber: h.chamber ?? null }))
      : [],
    texts: Array.isArray(b.texts)
      ? b.texts.map((t) => ({ docId: t.doc_id ?? null, type: t.type ?? null, mime: t.mime ?? null, url: t.url ?? null }))
      : [],
    url: b.url ?? b.state_link ?? null,
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
function legiscanFixtureName(url) {
  if (/[?&]op=getBill\b/.test(url)) return "legal-legiscan-bill";
  if (/[?&]op=getSearch\b/.test(url)) return "legal-legiscan-search";
  return null;
}
