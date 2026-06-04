// internet-archive.test.mjs — offline tests for the IA adapter (DD2-3).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InternetArchiveClient,
  IA_BASE_URL,
  IA_DOWNLOAD_BASE,
  iaFixtureName,
} from "./internet-archive.mjs";
import { LibraryHttpClient } from "./library-base.mjs";
import { AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new InternetArchiveClient({ fixtureMode: true, ...opts });
}

test("metadata shapes item + file pointers (no re-host)", async () => {
  const ia = fixtureClient();
  const m = await ia.metadata("cu31924013345974");
  assert.equal(m.found, true);
  assert.equal(m.identifier, "cu31924013345974");
  assert.match(m.title, /origin of species/i);
  assert.equal(m.licenseurl, "http://creativecommons.org/publicdomain/mark/1.0/");
  assert.equal(m.files.length, 2);
  // file URL is a POINTER to archive.org's download host, not bytes.
  assert.equal(
    m.files[0].url,
    `${IA_DOWNLOAD_BASE}/cu31924013345974/cu31924013345974.pdf`,
  );
});

test("metadata requires an identifier", async () => {
  const ia = fixtureClient();
  await assert.rejects(() => ia.metadata(""), AdapterError);
});

test("search shapes docs + numFound", async () => {
  const ia = fixtureClient();
  const r = await ia.search({ query: "creator:Darwin", mediatype: "texts" });
  assert.equal(r.numFound, 2);
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[0].identifier, "cu31924013345974");
  assert.equal(r.docs[0].licenseurl, "http://creativecommons.org/publicdomain/mark/1.0/");
});

test("search requires a query", async () => {
  const ia = fixtureClient();
  await assert.rejects(() => ia.search({}), AdapterError);
});

test("fileUrl builds a download pointer without fetching", () => {
  const ia = fixtureClient();
  assert.equal(
    ia.fileUrl("foo", "bar baz.pdf"),
    `${IA_DOWNLOAD_BASE}/foo/bar%20baz.pdf`,
  );
});

test("unknown identifier returns found:false", async () => {
  const http = new LibraryHttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const ia = new InternetArchiveClient({ http });
  const m = await ia.metadata("does-not-exist");
  assert.equal(m.found, false);
  assert.deepEqual(m.files, []);
});

test("fixture resolver + base url", () => {
  assert.equal(iaFixtureName("https://archive.org/metadata/x"), "ia-metadata");
  assert.equal(iaFixtureName("https://archive.org/advancedsearch.php?q=x"), "ia-search");
  assert.match(IA_BASE_URL, /archive\.org$/);
});
