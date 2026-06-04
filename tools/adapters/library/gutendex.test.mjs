// gutendex.test.mjs — offline tests for the Gutendex adapter (DD2-1).
import { test } from "node:test";
import assert from "node:assert/strict";

import { GutendexClient, GUTENDEX_BASE_URL, gutendexFixtureName } from "./gutendex.mjs";
import { LibraryHttpClient } from "./library-base.mjs";
import { AdapterError } from "../base.mjs";

function fixtureClient(opts = {}) {
  return new GutendexClient({ fixtureMode: true, ...opts });
}

test("searchBooks shapes a typed catalog page", async () => {
  const gx = fixtureClient();
  const page = await gx.searchBooks({ search: "frankenstein", languages: ["en"] });
  assert.equal(page.count, 2);
  assert.equal(page.results.length, 2);
  const b = page.results[0];
  assert.equal(b.id, 84);
  assert.match(b.title, /Frankenstein/);
  assert.equal(b.authors[0].name, "Shelley, Mary Wollstonecraft");
  assert.equal(b.copyright, false); // public domain tri-state preserved
  assert.equal(b.formats["application/epub+zip"], "https://www.gutenberg.org/ebooks/84.epub3.images");
  assert.ok(page.next);
});

test("bookById shapes a single book", async () => {
  const gx = fixtureClient();
  const b = await gx.bookById(1342);
  assert.equal(b.id, 1342);
  assert.equal(b.title, "Pride and Prejudice");
  assert.equal(b.authors[0].name, "Austen, Jane");
  assert.deepEqual(b.languages, ["en"]);
});

test("bookById rejects non-positive-integer ids", async () => {
  const gx = fixtureClient();
  await assert.rejects(() => gx.bookById("nope"), AdapterError);
  await assert.rejects(() => gx.bookById(0), AdapterError);
  await assert.rejects(() => gx.bookById(-3), AdapterError);
});

test("fixture resolver routes /books vs /books/{id}", () => {
  assert.equal(gutendexFixtureName("https://gutendex.com/books?search=x"), "gutendex-books");
  assert.equal(gutendexFixtureName("https://gutendex.com/books/84"), "gutendex-book");
  assert.equal(gutendexFixtureName("https://gutendex.com/other"), null);
});

test("base url default points at gutendex", () => {
  assert.match(GUTENDEX_BASE_URL, /gutendex\.com$/);
});

test("non-page payload surfaces AdapterError", async () => {
  const http = new LibraryHttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ not: "a page" }) }),
  });
  const gx = new GutendexClient({ http });
  await assert.rejects(() => gx.searchBooks({ search: "x" }), AdapterError);
});
