// open-library.test.mjs — offline tests for the Open Library adapter (DD2-4).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OpenLibraryClient,
  OPENLIBRARY_BASE_URL,
  OPENLIBRARY_COVERS_BASE,
  openLibraryFixtureName,
} from "./open-library.mjs";
import { AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new OpenLibraryClient({ fixtureMode: true, ...opts });
}

test("search shapes docs with IA pointers + access flag", async () => {
  const ol = fixtureClient();
  const r = await ol.search({ query: "fantastic mr fox" });
  assert.equal(r.numFound, 2);
  const d = r.docs[0];
  assert.equal(d.key, "/works/OL45804W");
  assert.equal(d.title, "Fantastic Mr Fox");
  assert.deepEqual(d.authorNames, ["Roald Dahl"]);
  // pointer into IA, not re-hosted content
  assert.deepEqual(d.iaIdentifiers, ["fantasticmrfox0000dahl"]);
  assert.equal(d.ebookAccess, "borrowable");
});

test("search requires at least one of query/title/author", async () => {
  const ol = fixtureClient();
  await assert.rejects(() => ol.search({}), AdapterError);
});

test("workById accepts OLID in several forms", async () => {
  const ol = fixtureClient();
  const w = await ol.workById("/works/OL45804W");
  assert.equal(w.key, "/works/OL45804W");
  assert.equal(w.title, "Fantastic Mr Fox");
  assert.deepEqual(w.authorKeys, ["/authors/OL34184A"]);
  // bare OLID form
  const w2 = await ol.workById("OL45804W");
  assert.equal(w2.title, "Fantastic Mr Fox");
});

test("workById rejects a non-OLID", async () => {
  const ol = fixtureClient();
  await assert.rejects(() => ol.workById("not-an-olid"), AdapterError);
});

test("editionByIsbn validates length + shapes ocaid pointer", async () => {
  const ol = fixtureClient();
  const e = await ol.editionByIsbn("978-0-14-032872-1");
  assert.deepEqual(e.isbn13, ["9780140328721"]);
  assert.equal(e.ocaid, "fantasticmrfox0000dahl");
  assert.equal(e.numberOfPages, 96);
  await assert.rejects(() => ol.editionByIsbn("123"), AdapterError);
});

test("coverUrl builds a pointer without fetching", () => {
  const ol = fixtureClient();
  assert.equal(ol.coverUrl({ key: "id", value: 6498519, size: "L" }), `${OPENLIBRARY_COVERS_BASE}/id/6498519-L.jpg`);
  // bad size/key fall back to defaults
  assert.equal(ol.coverUrl({ key: "bogus", value: "x", size: "Z" }), `${OPENLIBRARY_COVERS_BASE}/id/x-M.jpg`);
});

test("fixture resolver + base url", () => {
  assert.equal(openLibraryFixtureName("https://openlibrary.org/search.json?q=x"), "openlibrary-search");
  assert.equal(openLibraryFixtureName("https://openlibrary.org/works/OL1W.json"), "openlibrary-work");
  assert.equal(openLibraryFixtureName("https://openlibrary.org/isbn/123.json"), "openlibrary-edition");
  assert.match(OPENLIBRARY_BASE_URL, /openlibrary\.org$/);
});
