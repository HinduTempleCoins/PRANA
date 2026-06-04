// gutendex.mjs — typed Gutendex client (DD2-1).
//
// Gutendex (https://gutendex.com) is a free, key-less JSON API over the Project
// Gutenberg catalog (70k+ public-domain books). Read-only. Covers:
//   - GET /books                 -> search/filter the catalog (paginated)
//   - GET /books/{id}            -> one book's metadata by Gutenberg id
//
// Wired through the W9 base layer (rate-limited, TTL-cached, retrying, typed
// errors, fixture mode) exactly like the CoinGecko/DefiLlama/legal adapters.
//
// Public-domain note: Gutenberg books are public domain in the US. We surface
// the catalog metadata + Gutenberg-hosted format URLs; routing (HOST vs
// WINDOW vs AGGREGATE) is handled by the tier-routing layer, not here.
// See ../../design/library/tier-routing-spec.md.

import { TokenBucket, TTLCache, AdapterError } from "../base.mjs";
import { LibraryHttpClient } from "./library-base.mjs";

export const GUTENDEX_BASE_URL = "https://gutendex.com";

export class GutendexClient {
  constructor({
    baseUrl = GUTENDEX_BASE_URL,
    fixtureMode = false,
    // Be a polite client: a free public instance. Conservative bucket.
    rateLimiter = new TokenBucket({ capacity: 5, refillPerSec: 2 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null, // inject a pre-built HttpClient (tests do this)
    ...httpOpts
  } = {}) {
    this.http =
      http ??
      new LibraryHttpClient({
        baseUrl,
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: gutendexFixtureName,
        ...httpOpts,
      });
  }

  // GET /books?search=...&languages=en&page=N&... -> paginated catalog page.
  // Accepts the documented Gutendex query params; returns a shaped page with
  // typed book rows plus pagination cursors.
  async searchBooks({ search, languages, topic, author, ids, page, sort, copyright } = {}) {
    const params = new URLSearchParams();
    if (search != null && String(search).trim()) params.set("search", String(search).trim());
    if (languages) params.set("languages", normCsv(languages));
    if (topic != null && String(topic).trim()) params.set("topic", String(topic).trim());
    if (author != null && String(author).trim()) params.set("author_year_start", String(author).trim());
    if (ids) params.set("ids", normCsv(ids));
    if (page != null) params.set("page", String(page));
    if (sort) params.set("sort", String(sort));
    // copyright filter: Gutendex accepts true,false,null (csv) to filter by status.
    if (copyright != null) params.set("copyright", normCsv(copyright));

    const qs = params.toString();
    const raw = await this.http.getJson(`/books${qs ? `?${qs}` : ""}`, {
      fixture: "gutendex-books",
    });
    return shapeBookPage(raw);
  }

  // GET /books/{id} -> a single book by its Gutenberg id.
  async bookById(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AdapterError("bookById: id must be a positive integer", { details: { id } });
    }
    const raw = await this.http.getJson(`/books/${n}`, { fixture: "gutendex-book" });
    if (raw == null || typeof raw !== "object" || raw.id == null) {
      throw new AdapterError("bookById: unexpected payload", { details: { got: typeof raw } });
    }
    return shapeBook(raw);
  }
}

// ---- shaping / typing helpers -------------------------------------------

function normCsv(v) {
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(",");
}

function shapeBookPage(raw) {
  if (raw == null || typeof raw !== "object" || !Array.isArray(raw.results)) {
    throw new AdapterError("searchBooks: expected { results: [...] } payload", {
      details: { got: typeof raw },
    });
  }
  return {
    count: raw.count != null ? Number(raw.count) : null,
    next: raw.next ?? null,
    previous: raw.previous ?? null,
    results: raw.results.map(shapeBook),
  };
}

function shapeBook(b) {
  return {
    id: b.id != null ? Number(b.id) : null,
    title: b.title ?? null,
    authors: Array.isArray(b.authors)
      ? b.authors.map((a) => ({
          name: a?.name ?? null,
          birthYear: a?.birth_year ?? null,
          deathYear: a?.death_year ?? null,
        }))
      : [],
    subjects: Array.isArray(b.subjects) ? b.subjects : [],
    bookshelves: Array.isArray(b.bookshelves) ? b.bookshelves : [],
    languages: Array.isArray(b.languages) ? b.languages : [],
    // `copyright` is true / false / null in Gutendex — preserve the tri-state.
    copyright: b.copyright === undefined ? null : b.copyright,
    mediaType: b.media_type ?? null,
    // format MIME -> url map (Gutenberg-hosted). Pointers, not re-hosted bytes.
    formats: b.formats && typeof b.formats === "object" ? { ...b.formats } : {},
    downloadCount: b.download_count != null ? Number(b.download_count) : null,
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
export function gutendexFixtureName(url) {
  // /books/{id} (numeric path segment) -> single book; /books or /books?... -> page.
  if (/\/books\/\d+/.test(url)) return "gutendex-book";
  if (url.includes("/books")) return "gutendex-books";
  return null;
}
