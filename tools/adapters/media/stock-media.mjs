// stock-media.mjs — unified free-stock media adapter (EE2-6).
//
// One typed client over the free stock photo/video providers used by the
// SoapBox Media layer (Doc §8 "Stock"): Pexels, Pixabay, Coverr, Mixkit,
// Videvo. Each provider is normalised into a single `StockAsset` shape so the
// aggregator/feed can rank photo+video results across providers uniformly.
//
// Free-tier reality (verified against each provider's API docs):
//   - Pexels   — free API key, header `Authorization: <key>`. Photos + videos.
//   - Pixabay  — free API key, query param `key=<key>`. Photos + videos.
//   - Coverr   — free API key (Bearer). Video only.
//   - Mixkit   — NO public REST API; free stock under the Mixkit License. We
//                model it as a *catalog* source (curated/local feed entries),
//                not a live HTTP call, so it is fixture/catalog-only here.
//   - Videvo   — no open self-serve key (partner API). Modelled like Mixkit:
//                catalog-only, no live HTTP call.
//
// Wired through the shared base layer (../base.mjs): rate-limited, TTL-cached,
// retrying, typed errors, fixture mode for offline tests. API keys come from
// the environment (never hard-coded): PEXELS_API_KEY, PIXABAY_API_KEY,
// COVERR_API_KEY.

import { HttpClient, TokenBucket, TTLCache, AdapterError } from "../base.mjs";

export const PEXELS_BASE_URL = "https://api.pexels.com";
export const PIXABAY_BASE_URL = "https://pixabay.com";
export const COVERR_BASE_URL = "https://api.coverr.co";

// Providers that have a live, key'd REST API we can call.
export const LIVE_PROVIDERS = Object.freeze(["pexels", "pixabay", "coverr"]);
// Providers we only model as a license-clean catalog (no public REST API).
export const CATALOG_PROVIDERS = Object.freeze(["mixkit", "videvo"]);
export const STOCK_PROVIDERS = Object.freeze([...LIVE_PROVIDERS, ...CATALOG_PROVIDERS]);

export class StockMediaClient {
  constructor({
    fixtureMode = false,
    // Keys come from env by default; explicit opts override (tests pass keys).
    pexelsKey = process.env.PEXELS_API_KEY ?? null,
    pixabayKey = process.env.PIXABAY_API_KEY ?? null,
    coverrKey = process.env.COVERR_API_KEY ?? null,
    // Conservative shared budget across the providers.
    rateLimiter = new TokenBucket({ capacity: 10, refillPerSec: 1 }),
    cache = new TTLCache({ ttlMs: 300_000 }),
    http = null, // inject a pre-built HttpClient (tests do this)
    ...httpOpts
  } = {}) {
    this.pexelsKey = pexelsKey;
    this.pixabayKey = pixabayKey;
    this.coverrKey = coverrKey;
    // One HttpClient; each call passes absolute URLs so a single client serves
    // all hosts. fixtureResolver maps the URL → recorded JSON file.
    this.http =
      http ??
      new HttpClient({
        fixtureMode,
        rateLimiter,
        cache,
        fixtureResolver: (url) => stockFixtureName(url),
        ...httpOpts,
      });
  }

  // ---- Pexels ------------------------------------------------------------
  // GET /v1/search (photos) or /videos/search (videos). Key in Authorization.
  async pexels({ query, perPage = 15, page = 1, kind = "photos" } = {}) {
    const q = reqQuery(query);
    const isVideo = kind === "videos";
    const path = isVideo ? "/videos/search" : "/v1/search";
    const params = new URLSearchParams({ query: q, per_page: String(perPage), page: String(page) });
    const raw = await this.http.getJson(`${PEXELS_BASE_URL}${path}?${params.toString()}`, {
      headers: this.pexelsKey ? { Authorization: this.pexelsKey } : {},
      fixture: isVideo ? "stock-pexels-videos" : "stock-pexels-photos",
    });
    const rows = isVideo ? raw?.videos : raw?.photos;
    if (!Array.isArray(rows)) {
      throw new AdapterError("pexels: expected results array", { details: { got: typeof rows } });
    }
    return rows.map((r) => (isVideo ? shapePexelsVideo(r) : shapePexelsPhoto(r)));
  }

  // ---- Pixabay -----------------------------------------------------------
  // GET / (photos) or /videos/ (videos). Key in the `key` query param.
  async pixabay({ query, perPage = 20, page = 1, kind = "photos" } = {}) {
    const q = reqQuery(query);
    const isVideo = kind === "videos";
    const path = isVideo ? "/api/videos/" : "/api/";
    const params = new URLSearchParams({ q, per_page: String(perPage), page: String(page) });
    if (this.pixabayKey) params.set("key", this.pixabayKey);
    const raw = await this.http.getJson(`${PIXABAY_BASE_URL}${path}?${params.toString()}`, {
      fixture: isVideo ? "stock-pixabay-videos" : "stock-pixabay-photos",
    });
    const rows = raw?.hits;
    if (!Array.isArray(rows)) {
      throw new AdapterError("pixabay: expected hits array", { details: { got: typeof rows } });
    }
    return rows.map((r) => (isVideo ? shapePixabayVideo(r) : shapePixabayPhoto(r)));
  }

  // ---- Coverr (video only) ----------------------------------------------
  // GET /videos?query=... with a Bearer key.
  async coverr({ query, perPage = 20, page = 1 } = {}) {
    const q = reqQuery(query);
    const params = new URLSearchParams({ query: q, page_size: String(perPage), page: String(page) });
    const raw = await this.http.getJson(`${COVERR_BASE_URL}/videos?${params.toString()}`, {
      headers: this.coverrKey ? { Authorization: `Bearer ${this.coverrKey}` } : {},
      fixture: "stock-coverr-videos",
    });
    const rows = raw?.hits ?? raw?.videos;
    if (!Array.isArray(rows)) {
      throw new AdapterError("coverr: expected hits array", { details: { got: typeof rows } });
    }
    return rows.map(shapeCoverrVideo);
  }

  // ---- Catalog providers (Mixkit / Videvo): no live API -----------------
  // These have no public self-serve REST API. We expose a tiny helper so the
  // caller can fold curated/local catalog entries into the same StockAsset
  // shape, and a guard so an accidental "fetch from Mixkit" fails loudly.
  catalog(provider, entries = []) {
    const p = String(provider).toLowerCase();
    if (!CATALOG_PROVIDERS.includes(p)) {
      throw new AdapterError(`catalog(): ${p} is not a catalog-only provider`, {
        details: { provider: p, expected: CATALOG_PROVIDERS },
      });
    }
    if (!Array.isArray(entries)) {
      throw new AdapterError("catalog(): entries must be an array");
    }
    return entries.map((e) => shapeCatalogEntry(p, e));
  }
}

// ---- shaping / typing helpers -------------------------------------------

function reqQuery(query) {
  const q = query == null ? "" : String(query).trim();
  if (!q) throw new AdapterError("query is required");
  return q;
}

// Unified StockAsset:
//   { provider, id, type, width, height, url, src, thumb, author, license }
function shapePexelsPhoto(r) {
  return {
    provider: "pexels",
    id: String(r.id),
    type: "photo",
    width: r.width ?? null,
    height: r.height ?? null,
    url: r.url ?? null,
    src: r.src?.original ?? r.src?.large ?? null,
    thumb: r.src?.tiny ?? r.src?.small ?? null,
    author: r.photographer ?? null,
    license: "Pexels License",
  };
}
function shapePexelsVideo(r) {
  const file = Array.isArray(r.video_files) ? r.video_files[0] : null;
  return {
    provider: "pexels",
    id: String(r.id),
    type: "video",
    width: r.width ?? null,
    height: r.height ?? null,
    url: r.url ?? null,
    src: file?.link ?? null,
    thumb: r.image ?? null,
    author: r.user?.name ?? null,
    license: "Pexels License",
  };
}
function shapePixabayPhoto(r) {
  return {
    provider: "pixabay",
    id: String(r.id),
    type: "photo",
    width: r.imageWidth ?? null,
    height: r.imageHeight ?? null,
    url: r.pageURL ?? null,
    src: r.largeImageURL ?? r.webformatURL ?? null,
    thumb: r.previewURL ?? null,
    author: r.user ?? null,
    license: "Pixabay Content License",
  };
}
function shapePixabayVideo(r) {
  const v = r.videos?.large ?? r.videos?.medium ?? r.videos?.small ?? null;
  return {
    provider: "pixabay",
    id: String(r.id),
    type: "video",
    width: v?.width ?? null,
    height: v?.height ?? null,
    url: r.pageURL ?? null,
    src: v?.url ?? null,
    thumb: r.picture_id ? `https://i.vimeocdn.com/video/${r.picture_id}_295x166.jpg` : null,
    author: r.user ?? null,
    license: "Pixabay Content License",
  };
}
function shapeCoverrVideo(r) {
  return {
    provider: "coverr",
    id: String(r.id),
    type: "video",
    width: r.max_width ?? r.width ?? null,
    height: r.max_height ?? r.height ?? null,
    url: r.urls?.page ?? null,
    src: r.urls?.mp4 ?? r.urls?.mp4_download ?? null,
    thumb: r.thumbnail ?? r.poster ?? null,
    author: r.author ?? "Coverr",
    license: "Coverr License",
  };
}
function shapeCatalogEntry(provider, e) {
  return {
    provider,
    id: String(e.id ?? e.slug ?? ""),
    type: e.type ?? "video",
    width: e.width ?? null,
    height: e.height ?? null,
    url: e.url ?? null,
    src: e.src ?? null,
    thumb: e.thumb ?? null,
    author: e.author ?? null,
    license: provider === "mixkit" ? "Mixkit License" : "Videvo License",
  };
}

// Pick the fixture file from a request URL (used only in fixture mode).
function stockFixtureName(url) {
  if (url.includes("api.pexels.com/videos")) return "stock-pexels-videos";
  if (url.includes("api.pexels.com")) return "stock-pexels-photos";
  if (url.includes("pixabay.com/api/videos")) return "stock-pixabay-videos";
  if (url.includes("pixabay.com/api")) return "stock-pixabay-photos";
  if (url.includes("api.coverr.co")) return "stock-coverr-videos";
  return null;
}
