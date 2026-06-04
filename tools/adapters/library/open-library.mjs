// open-library.mjs — typed Open Library client (DD2-4).
//
// Read-only, key-less clients over openlibrary.org's JSON API:
//   - GET /search.json?q=...              -> work/edition search
//   - GET /works/{OLID}.json              -> a work record
//   - GET /isbn/{isbn}.json               -> an edition by ISBN
//   - GET /api/books?bibkeys=ISBN:...     -> bibkey lookup (jscmd=data)
//
// Open Library is metadata about books (works, editions, authors, covers). It
// is NOT a content host — most full text lives on the Internet Archive and is
// access-controlled there. So this adapter returns BIBLIOGRAPHIC METADATA plus
// (where present) a pointer to the IA identifier / cover; it never re-hosts
// text. Tier routing decides HOST vs WINDOW vs AGGREGATE.
// See ../../design/library/tier-routing-spec.md.
//
// Wired through the W9 base layer like every other adapter here.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LibraryHttpClient } from "./library-base.mjs";

export const OPENLIBRARY_BASE_URL = "https://openlibrary.org";
export const OPENLIBRARY_COVERS_BASE = "https://covers.openlibrary.org/b";

export class OpenLibraryClient {
  constructor({
    baseUrl = OPENLIBRARY_BASE_URL,
    fixtureMode = false,
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null,
    ...httpOpts
  } = {}) {
    this.http =
      http ??
      new LibraryHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: openLibraryFixtureName,
        ...httpOpts,
      });
  }

  // GET /search.json?q=...&page=N&limit=L -> shaped search page.
  async search({ query, title, author, page, limit = 20, fields } = {}) {
    const params = new URLSearchParams();
    if (query != null && String(query).trim()) params.set("q", String(query).trim());
    if (title != null && String(title).trim()) params.set("title", String(title).trim());
    if (author != null && String(author).trim()) params.set("author", String(author).trim());
    if (!params.toString()) {
      throw new AdapterError("search: one of query/title/author is required");
    }
    if (page != null) params.set("page", String(page));
    params.set("limit", String(limit));
    if (Array.isArray(fields) && fields.length) params.set("fields", fields.join(","));

    const raw = await this.http.getJson(`/search.json?${params.toString()}`, {
      fixture: "openlibrary-search",
    });
    return shapeSearch(raw);
  }

  // GET /works/{OLID}.json -> a single work record.
  async workById(olid) {
    const id = normOlid(olid);
    const raw = await this.http.getJson(`/works/${id}.json`, { fixture: "openlibrary-work" });
    if (raw == null || typeof raw !== "object") {
      throw new AdapterError("workById: unexpected payload", { details: { got: typeof raw } });
    }
    return shapeWork(raw);
  }

  // GET /isbn/{isbn}.json -> an edition by ISBN.
  async editionByIsbn(isbn) {
    const clean = String(isbn ?? "").replace(/[^0-9Xx]/g, "");
    if (clean.length !== 10 && clean.length !== 13) {
      throw new AdapterError("editionByIsbn: isbn must be 10 or 13 chars", { details: { isbn } });
    }
    const raw = await this.http.getJson(`/isbn/${clean}.json`, { fixture: "openlibrary-edition" });
    if (raw == null || typeof raw !== "object") {
      throw new AdapterError("editionByIsbn: unexpected payload", { details: { got: typeof raw } });
    }
    return shapeEdition(raw);
  }

  // Build a cover-image POINTER URL. Does NOT fetch. key in {id, isbn, olid}.
  coverUrl({ key = "id", value, size = "M" } = {}) {
    const v = String(value ?? "").trim();
    if (!v) throw new AdapterError("coverUrl: value is required");
    const k = ["id", "isbn", "olid", "oclc", "lccn"].includes(key) ? key : "id";
    const s = ["S", "M", "L"].includes(size) ? size : "M";
    return `${OPENLIBRARY_COVERS_BASE}/${k}/${encodeURIComponent(v)}-${s}.jpg`;
  }
}

// ---- shaping / typing helpers -------------------------------------------

function normOlid(olid) {
  const s = String(olid ?? "").trim();
  if (!s) throw new AdapterError("workById: olid is required");
  // Accept "OL123W", "/works/OL123W", or "works/OL123W".
  const m = s.match(/(OL\d+[A-Z])/i);
  if (!m) throw new AdapterError("workById: not a valid OLID", { details: { olid } });
  return m[1].toUpperCase();
}

function shapeSearch(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.docs)) {
    throw new AdapterError("search: expected { docs: [...] } payload", {
      details: { got: typeof raw },
    });
  }
  return {
    numFound: raw.numFound != null ? Number(raw.numFound) : (raw.num_found != null ? Number(raw.num_found) : null),
    start: raw.start != null ? Number(raw.start) : null,
    docs: raw.docs.map((d) => ({
      key: d.key ?? null, // e.g. /works/OL...W
      title: d.title ?? null,
      authorNames: Array.isArray(d.author_name) ? d.author_name : [],
      firstPublishYear: d.first_publish_year ?? null,
      editionCount: d.edition_count != null ? Number(d.edition_count) : null,
      isbns: Array.isArray(d.isbn) ? d.isbn.slice(0, 25) : [],
      coverId: d.cover_i ?? null,
      // pointer into IA where full text (if any) lives; access-controlled there.
      iaIdentifiers: Array.isArray(d.ia) ? d.ia : [],
      ebookAccess: d.ebook_access ?? null,
    })),
  };
}

function shapeWork(w) {
  return {
    key: w.key ?? null,
    title: w.title ?? null,
    description: typeof w.description === "string" ? w.description : (w.description?.value ?? null),
    subjects: Array.isArray(w.subjects) ? w.subjects : [],
    authorKeys: Array.isArray(w.authors)
      ? w.authors.map((a) => a?.author?.key ?? null).filter(Boolean)
      : [],
    covers: Array.isArray(w.covers) ? w.covers : [],
    firstPublishDate: w.first_publish_date ?? null,
  };
}

function shapeEdition(e) {
  return {
    key: e.key ?? null,
    title: e.title ?? null,
    isbn10: Array.isArray(e.isbn_10) ? e.isbn_10 : [],
    isbn13: Array.isArray(e.isbn_13) ? e.isbn_13 : [],
    publishers: Array.isArray(e.publishers) ? e.publishers : [],
    publishDate: e.publish_date ?? null,
    numberOfPages: e.number_of_pages != null ? Number(e.number_of_pages) : null,
    workKeys: Array.isArray(e.works) ? e.works.map((x) => x?.key ?? null).filter(Boolean) : [],
    // pointer into IA where a scan may live (access-controlled there).
    ocaid: e.ocaid ?? null,
    covers: Array.isArray(e.covers) ? e.covers : [],
  };
}

export function openLibraryFixtureName(url) {
  if (url.includes("/search.json")) return "openlibrary-search";
  if (/\/works\/OL/i.test(url)) return "openlibrary-work";
  if (/\/isbn\//i.test(url)) return "openlibrary-edition";
  return null;
}
