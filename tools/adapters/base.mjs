// base.mjs — shared adapter layer for PRANA data adapters.
//
// Every adapter (RPC, price feeds, TVL feeds) imports from here so they share
// one consistent surface for: typed errors, retrying fetch with exponential
// backoff + jitter, token-bucket rate limiting, a TTL response cache, and a
// fixture mode that serves recorded JSON instead of touching the network.
//
// Design goals:
//   - Fully unit-testable offline. All time/randomness/fetch/sleep are
//     injectable so tests can use a fake clock and deterministic jitter.
//   - No framework, no transpile. Plain ESM, runs on bare Node.
//
// Nothing here is network-bound by default in fixture mode, which is what the
// test suite uses exclusively.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

// --------------------------------------------------------------------------
// Typed errors
// --------------------------------------------------------------------------

// Base class for every error this layer raises. Carries an optional `cause`
// and a `details` bag so callers can branch on machine-readable context.
export class AdapterError extends Error {
  constructor(message, { cause, details } = {}) {
    super(message);
    this.name = "AdapterError";
    if (cause !== undefined) this.cause = cause;
    this.details = details ?? {};
  }
}

// Upstream said "slow down" (HTTP 429) or our own limiter refused the call.
// `retryAfterMs` is the suggested wait when the upstream provided one.
export class RateLimitError extends AdapterError {
  constructor(message, { cause, details, retryAfterMs } = {}) {
    super(message, { cause, details });
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

// Upstream returned a non-OK, non-429 response, or the body could not be
// parsed. `status` is the HTTP status when there was one.
export class UpstreamError extends AdapterError {
  constructor(message, { cause, details, status } = {}) {
    super(message, { cause, details });
    this.name = "UpstreamError";
    this.status = status ?? null;
  }
}

// --------------------------------------------------------------------------
// Token-bucket rate limiter
// --------------------------------------------------------------------------

// Classic token bucket: `capacity` tokens, refilled at `refillPerSec`. Each
// call to take() removes one token. `tryTake()` is non-blocking and returns a
// boolean; `take()` waits (via the injected sleep) until a token is free.
//
// `now` and `sleep` are injectable so the limiter is testable with a fake
// clock — no real wall-clock waiting in tests.
export class TokenBucket {
  constructor({
    capacity = 10,
    refillPerSec = 5,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (capacity <= 0) throw new AdapterError("TokenBucket capacity must be > 0");
    if (refillPerSec <= 0) throw new AdapterError("TokenBucket refillPerSec must be > 0");
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this._now = now;
    this._sleep = sleep;
    this.tokens = capacity;
    this._last = now();
  }

  _refill() {
    const t = this._now();
    const elapsedSec = Math.max(0, (t - this._last) / 1000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this._last = t;
    }
  }

  // Non-blocking: consume a token if available, else false.
  tryTake() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  // Milliseconds until at least one token will be available.
  msUntilToken() {
    this._refill();
    if (this.tokens >= 1) return 0;
    const need = 1 - this.tokens;
    return Math.ceil((need / this.refillPerSec) * 1000);
  }

  // Blocking (cooperative): wait until a token is free, then consume it.
  async take() {
    // Loop because, under a fake clock, sleeping does not advance refill on
    // its own — the caller's clock does. We re-check after each wait.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.tryTake()) return;
      const wait = this.msUntilToken();
      await this._sleep(wait > 0 ? wait : 1);
    }
  }
}

// --------------------------------------------------------------------------
// TTL response cache (Map-based)
// --------------------------------------------------------------------------

// Tiny TTL cache. Keys are strings, values are arbitrary. Entries expire after
// `ttlMs`. `now` is injectable for deterministic expiry tests. Not an LRU; an
// optional `maxEntries` cap evicts the oldest-inserted entry when exceeded.
export class TTLCache {
  constructor({ ttlMs = 30_000, now = () => Date.now(), maxEntries = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this._now = now;
    this.maxEntries = maxEntries;
    this._map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this._map.get(key);
    if (entry === undefined) return undefined;
    if (this._now() >= entry.expiresAt) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    // Re-insert at the end for insertion-order eviction.
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, expiresAt: this._now() + ttlMs });
    if (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    return value;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }
}

// --------------------------------------------------------------------------
// Sleep + jitter helpers
// --------------------------------------------------------------------------

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff (AWS "Exponential Backoff And Jitter").
// delay = random_between(0, min(cap, base * 2**attempt)).
// `rng` is injectable so tests are deterministic.
export function backoffDelay(attempt, { baseMs = 200, capMs = 10_000, rng = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rng() * exp);
}

// --------------------------------------------------------------------------
// Fixture mode
// --------------------------------------------------------------------------

// Loads recorded JSON from tools/adapters/fixtures/<name>.json. Throws an
// UpstreamError if the fixture is missing, so a test that forgets to record a
// payload fails loudly rather than silently hitting the network.
export async function loadFixture(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(FIXTURES_DIR, `${safe}.json`);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new UpstreamError(`fixture missing: ${safe}.json`, {
        cause: err,
        details: { fixture: safe, file },
      });
    }
    throw new UpstreamError(`fixture unreadable: ${safe}.json`, { cause: err });
  }
}

// --------------------------------------------------------------------------
// HttpClient — retrying, rate-limited, cached fetch wrapper
// --------------------------------------------------------------------------

// The workhorse. Adapters build one HttpClient and call getJson(). It:
//   1. honours fixtureMode (serve recorded JSON, never touch the network);
//   2. serves from the TTL cache on a hit;
//   3. waits on the token bucket;
//   4. fetches with retry + full-jitter exponential backoff on transient
//      failures (network error, 429, 5xx);
//   5. maps failures to typed errors;
//   6. caches successful JSON responses.
//
// Everything time/network/random is injectable for offline tests.
export class HttpClient {
  constructor({
    baseUrl = "",
    defaultHeaders = {},
    fixtureMode = false,
    // fixtureResolver maps a (url, options) call to a fixture name. Adapters
    // that want fixture mode must supply one (or pass a per-call fixture).
    fixtureResolver = null,
    maxRetries = 3,
    backoff = {}, // { baseMs, capMs }
    cache = null, // a TTLCache instance, or null to disable caching
    cacheTtlMs = 30_000,
    rateLimiter = null, // a TokenBucket instance, or null to disable
    timeoutMs = 15_000,
    // Injectables (overridden in tests):
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    rng = Math.random,
    now = () => Date.now(),
  } = {}) {
    this.baseUrl = baseUrl;
    this.defaultHeaders = defaultHeaders;
    this.fixtureMode = fixtureMode;
    this.fixtureResolver = fixtureResolver;
    this.maxRetries = maxRetries;
    this.backoff = backoff;
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs;
    this.rateLimiter = rateLimiter;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
    this._sleep = sleep;
    this._rng = rng;
    this._now = now;
  }

  _url(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    if (!this.baseUrl) return pathOrUrl;
    return this.baseUrl.replace(/\/+$/, "") + "/" + String(pathOrUrl).replace(/^\/+/, "");
  }

  _cacheKey(url, options) {
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    return `${method} ${url} ${body}`;
  }

  // GET (or arbitrary method) returning parsed JSON, with all base-layer
  // behaviour applied. `fixture` overrides the resolver for this call.
  async getJson(pathOrUrl, { headers = {}, method = "GET", body, fixture, cacheTtlMs } = {}) {
    const url = this._url(pathOrUrl);
    const options = {
      method,
      headers: { ...this.defaultHeaders, ...headers },
      body,
    };

    // Fixture mode short-circuits everything network-related.
    if (this.fixtureMode) {
      const name = fixture ?? (this.fixtureResolver && this.fixtureResolver(url, options));
      if (!name) {
        throw new UpstreamError("fixtureMode is on but no fixture name was resolved", {
          details: { url, method },
        });
      }
      return loadFixture(name);
    }

    // Cache lookup (only meaningful for idempotent reads; adapters decide what
    // they route through here).
    const key = this._cacheKey(url, options);
    if (this.cache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }

    const data = await this._fetchWithRetry(url, options);

    if (this.cache) {
      this.cache.set(key, data, cacheTtlMs ?? this.cacheTtlMs);
    }
    return data;
  }

  async _fetchWithRetry(url, options) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Rate-limit each network attempt.
      if (this.rateLimiter) await this.rateLimiter.take();

      try {
        return await this._fetchOnce(url, options);
      } catch (err) {
        lastErr = err;
        const retriable = this._isRetriable(err);
        if (!retriable || attempt === this.maxRetries) {
          throw err;
        }
        // Prefer the upstream's Retry-After when it gave one.
        let delay;
        if (err instanceof RateLimitError && err.retryAfterMs != null) {
          delay = err.retryAfterMs;
        } else {
          delay = backoffDelay(attempt, { ...this.backoff, rng: this._rng });
        }
        await this._sleep(delay);
      }
    }
    // Unreachable, but keep the type-checker / readers happy.
    throw lastErr;
  }

  _isRetriable(err) {
    if (err instanceof RateLimitError) return true;
    if (err instanceof UpstreamError) {
      // Retry only 5xx (and unknown/null status from a thrown network error).
      return err.status == null || (err.status >= 500 && err.status <= 599);
    }
    // A raw network/abort error is retriable.
    return true;
  }

  async _fetchOnce(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this._fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      throw new UpstreamError(`network error: ${err?.message ?? err}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after"));
      throw new RateLimitError("upstream rate limited (429)", {
        status: 429,
        retryAfterMs: retryAfter,
        details: { url },
      });
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        /* ignore */
      }
      throw new UpstreamError(`upstream returned HTTP ${res.status}`, {
        status: res.status,
        details: { url, body: bodyText.slice(0, 500) },
      });
    }

    try {
      return await res.json();
    } catch (err) {
      throw new UpstreamError("failed to parse JSON response", { cause: err, details: { url } });
    }
  }
}

// Retry-After can be seconds (most common) or an HTTP-date. We handle the
// numeric form; date form returns null (we fall back to backoff).
export function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  return null;
}
