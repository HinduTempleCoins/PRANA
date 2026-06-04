// legal-adapters.test.mjs — offline tests for the 7 SoapBox legal/gov adapters
// (BB2-1..7). All run in fixture mode (no live network), asserting: parsed
// records, pagination shape, and error handling. Mirrors the W2/W3 test style.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AdapterError, UpstreamError, HttpClient } from "../base.mjs";

import { CourtListenerClient, COURTLISTENER_BASE_URL } from "./courtlistener.mjs";
import { CaselawAccessClient, CASELAW_BASE_URL } from "./caselaw-access.mjs";
import { GovInfoClient, GOVINFO_BASE_URL } from "./govinfo.mjs";
import { USCodeUSLMClient, USCODE_BASE_URL, parseUSLM } from "./uscode-uslm.mjs";
import { ECFRClient, ECFR_BASE_URL } from "./ecfr.mjs";
import { FederalRegisterClient, FEDERAL_REGISTER_BASE_URL } from "./federal-register.mjs";
import { RecapClient, RECAP_BASE_URL } from "./recap.mjs";

// ---------------------------------------------------------------------------
// 1. CourtListener (BB2-1)
// ---------------------------------------------------------------------------
test("courtlistener: search returns a DRF page with typed results", async () => {
  const cl = new CourtListenerClient({ fixtureMode: true });
  const page = await cl.search({ q: "first amendment", type: "o" });
  assert.equal(page.count, 2);
  assert.match(page.next, /page=2/); // pagination shape
  assert.equal(page.previous, null);
  assert.equal(page.results.length, 2);
  assert.equal(page.results[0].caseName, "Brandenburg v. Ohio");
  assert.deepEqual(page.results[0].citation, ["395 U.S. 444"]);
});

test("courtlistener: getOpinion + getDocket parse single records", async () => {
  const cl = new CourtListenerClient({ fixtureMode: true });
  const op = await cl.getOpinion(108713);
  assert.equal(op.id, 108713);
  assert.equal(op.perCuriam, true);
  const dk = await cl.getDocket(4214664);
  assert.equal(dk.docketNumber, "21-12345");
  assert.equal(dk.court, "ca9");
});

test("courtlistener: search requires q; token sent as Authorization header", async () => {
  const cl = new CourtListenerClient({ fixtureMode: true });
  await assert.rejects(() => cl.search({ q: "" }), AdapterError);
  const withKey = new CourtListenerClient({ fixtureMode: true, apiKey: "tok-123" });
  assert.equal(withKey.http.defaultHeaders.Authorization, "Token tok-123");
});

// ---------------------------------------------------------------------------
// 2. Caselaw Access Project (BB2-2)
// ---------------------------------------------------------------------------
test("caselaw: search + getCase parse cases (incl. casebody on full_case)", async () => {
  const cap = new CaselawAccessClient({ fixtureMode: true });
  const page = await cap.search({ search: "judicial review" });
  assert.equal(page.count, 1);
  assert.equal(page.results[0].nameAbbreviation, "Marbury v. Madison");
  assert.equal(page.results[0].citations[0].cite, "5 U.S. 137");
  const one = await cap.getCase(435800, { fullCase: true });
  assert.equal(one.jurisdiction.slug, "us");
  assert.match(one.bodyText, /province and duty of the judicial department/);
});

test("caselaw: search requires a term", async () => {
  const cap = new CaselawAccessClient({ fixtureMode: true });
  await assert.rejects(() => cap.search({}), AdapterError);
});

// ---------------------------------------------------------------------------
// 3. govinfo (BB2-3)
// ---------------------------------------------------------------------------
test("govinfo: collection search has pagination + typed package rows", async () => {
  const gi = new GovInfoClient({ fixtureMode: true });
  const page = await gi.search({
    collection: "BILLS",
    startDate: "2024-01-01T00:00:00Z",
    endDate: "2024-01-31T00:00:00Z",
  });
  assert.equal(page.count, 2);
  assert.match(page.nextPage, /offsetMark/); // pagination shape
  assert.equal(page.results[0].packageId, "BILLS-118hr3016ih");
});

test("govinfo: getPackage + getGranules parse records; key chain falls back to DEMO_KEY", async () => {
  const gi = new GovInfoClient({ fixtureMode: true });
  assert.equal(gi.apiKey, "DEMO_KEY"); // documented env fallback when none set
  const pkg = await gi.getPackage("BILLS-118hr3016ih");
  assert.equal(pkg.congress, "118");
  const gr = await gi.getGranules("BILLS-118hr3016ih");
  assert.equal(gr.results[0].granuleClass, "section");
});

test("govinfo: missing args throw AdapterError", async () => {
  const gi = new GovInfoClient({ fixtureMode: true });
  await assert.rejects(() => gi.search({ collection: "BILLS" }), AdapterError);
  await assert.rejects(() => gi.getPackage(""), AdapterError);
});

// ---------------------------------------------------------------------------
// 4. US Code USLM XML (BB2-4)
// ---------------------------------------------------------------------------
test("uscode-uslm: fetchDocument parses USLM XML sections", async () => {
  const us = new USCodeUSLMClient({ fixtureMode: true });
  const doc = await us.getTitle("17");
  assert.equal(doc.title, "Copyrights");
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].num, "102");
  assert.match(doc.sections[1].heading, /Fair use/);
});

test("uscode-uslm: searchInDocument filters sections; parseUSLM rejects non-XML", async () => {
  const us = new USCodeUSLMClient({ fixtureMode: true });
  const res = await us.searchInDocument("/whatever", { query: "fair use" });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].num, "107");
  assert.throws(() => parseUSLM("not xml at all"), AdapterError);
});

// ---------------------------------------------------------------------------
// 5. eCFR (BB2-5)
// ---------------------------------------------------------------------------
test("ecfr: search has meta pagination + typed hits", async () => {
  const ec = new ECFRClient({ fixtureMode: true });
  const out = await ec.search({ query: "stationary sources" });
  assert.equal(out.total, 1);
  assert.equal(out.totalPages, 1); // pagination shape from meta
  assert.equal(out.results[0].hierarchy.title, "40");
});

test("ecfr: structure + agencies parse", async () => {
  const ec = new ECFRClient({ fixtureMode: true });
  const struct = await ec.getTitleStructure(40, { date: "2024-01-01" });
  assert.equal(struct.type, "title");
  assert.equal(struct.children[0].children[0].identifier, "60");
  const agencies = await ec.getAgencies();
  assert.equal(agencies[0].shortName, "EPA");
});

// ---------------------------------------------------------------------------
// 6. Federal Register (BB2-6)
// ---------------------------------------------------------------------------
test("federal-register: search pagination + typed docs; getDocument single", async () => {
  const fr = new FederalRegisterClient({ fixtureMode: true });
  const page = await fr.search({ term: "endangered" });
  assert.equal(page.count, 2);
  assert.equal(page.totalPages, 1); // pagination shape
  assert.equal(page.results[0].documentNumber, "2024-01234");
  assert.deepEqual(page.results[0].agencies, ["Fish and Wildlife Service", "Interior Department"]);
  const doc = await fr.getDocument("2024-01234");
  assert.equal(doc.citation, "89 FR 3456");
});

test("federal-register: search requires a term", async () => {
  const fr = new FederalRegisterClient({ fixtureMode: true });
  await assert.rejects(() => fr.search({}), AdapterError);
});

// ---------------------------------------------------------------------------
// 7. RECAP Archive read-only (BB2-7)
// ---------------------------------------------------------------------------
test("recap: search + docket-entries pagination + document parse", async () => {
  const rc = new RecapClient({ fixtureMode: true });
  const page = await rc.search({ q: "securities litigation" });
  assert.equal(page.count, 1);
  assert.equal(page.results[0].court, "nysd");
  const entries = await rc.getDocketEntries(65663226);
  assert.match(entries.next, /page=2/); // pagination shape
  assert.equal(entries.results[0].recapDocuments[0].pageCount, 42);
  const doc = await rc.getDocument(350110001);
  assert.equal(doc.isAvailable, true);
  assert.equal(doc.documentNumber, "1");
});

test("recap: search requires q", async () => {
  const rc = new RecapClient({ fixtureMode: true });
  await assert.rejects(() => rc.search({ q: "" }), AdapterError);
});

// ---------------------------------------------------------------------------
// Cross-cutting: base-url defaults + error mapping through injected HttpClient
// ---------------------------------------------------------------------------
test("base-url defaults point at the right public hosts", () => {
  assert.match(COURTLISTENER_BASE_URL, /courtlistener\.com\/api\/rest\/v4$/);
  assert.match(CASELAW_BASE_URL, /api\.case\.law\/v1$/);
  assert.match(GOVINFO_BASE_URL, /api\.govinfo\.gov$/);
  assert.match(USCODE_BASE_URL, /uscode\.house\.gov$/);
  assert.match(ECFR_BASE_URL, /ecfr\.gov$/);
  assert.match(FEDERAL_REGISTER_BASE_URL, /federalregister\.gov$/);
  assert.match(RECAP_BASE_URL, /courtlistener\.com\/api\/rest\/v4$/);
});

test("upstream 429 surfaces as RateLimitError through an injected HttpClient", async () => {
  const http = new HttpClient({
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => "rl" }),
  });
  const fr = new FederalRegisterClient({ http });
  await assert.rejects(() => fr.search({ term: "x" }), (e) => {
    assert.equal(e.name, "RateLimitError");
    return true;
  });
});

test("non-page payload throws AdapterError", async () => {
  const http = new HttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "a page" }) }),
  });
  const cl = new CourtListenerClient({ http });
  await assert.rejects(() => cl.search({ q: "x" }), AdapterError);
});

test("fixture mode with an unknown fixture fails loud (UpstreamError)", async () => {
  // Force the resolver to miss by hitting a path no resolver maps.
  const cl = new CourtListenerClient({ fixtureMode: true });
  await assert.rejects(() => cl.http.getJson("/unmapped-path/"), UpstreamError);
});
