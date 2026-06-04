// legal-base.mjs — shared glue for the SoapBox legal/government API adapters.
//
// These 7 adapters (CourtListener, Caselaw Access Project, govinfo, US Code
// USLM, eCFR, Federal Register, RECAP) are all READ-ONLY clients over public
// legal/government APIs. They reuse the W9 adapter base in ../base.mjs verbatim
// (HttpClient: retry + full-jitter backoff, token-bucket rate limit, TTL cache,
// typed errors, fixture mode) — same constructor shape, same fixture-mode
// fallback, same typed-error taxonomy as the W2/W3 CoinGecko/DefiLlama adapters.
//
// The only thing this file adds is a fixture loader that reads recorded JSON
// from THIS folder's ./fixtures/ (so each adapter's fixtures sit next to it),
// rather than the central tools/adapters/fixtures/ dir that base.loadFixture
// targets. Everything else is the unchanged base layer.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { HttpClient, UpstreamError, RateLimitError, backoffDelay, parseRetryAfter } from "../base.mjs";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

// Same semantics as base.loadFixture, but rooted at legal/fixtures/. Throws an
// UpstreamError when a fixture is missing so a forgotten recording fails loudly
// instead of silently hitting the network.
export async function loadLegalFixture(name) {
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

// Text-fixture loader (for non-JSON payloads like USLM XML). Reads
// legal/fixtures/<name> verbatim. `name` should include its extension
// (e.g. "uscode-uslm-section.xml").
export async function loadLegalTextFixture(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(FIXTURES_DIR, safe);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new UpstreamError(`fixture missing: ${safe}`, { cause: err, details: { fixture: safe, file } });
    }
    throw new UpstreamError(`fixture unreadable: ${safe}`, { cause: err });
  }
}

// HttpClient that serves fixtures from legal/fixtures/. Identical to the base
// HttpClient in every other respect (retry, rate limit, cache, typed errors);
// it only overrides the fixture-mode branch of getJson to use loadLegalFixture.
export class LegalHttpClient extends HttpClient {
  async getJson(pathOrUrl, { headers = {}, method = "GET", body, fixture, cacheTtlMs } = {}) {
    if (this.fixtureMode) {
      const url = this._url(pathOrUrl);
      const options = { method, headers: { ...this.defaultHeaders, ...headers }, body };
      const name = fixture ?? (this.fixtureResolver && this.fixtureResolver(url, options));
      if (!name) {
        throw new UpstreamError("fixtureMode is on but no fixture name was resolved", {
          details: { url, method },
        });
      }
      return loadLegalFixture(name);
    }
    return super.getJson(pathOrUrl, { headers, method, body, fixture, cacheTtlMs });
  }

  // getText — same retry/rate-limit/cache/typed-error policy as getJson, but
  // returns the raw response body as text (for XML/USLM payloads). In fixture
  // mode it serves a verbatim text fixture (name must include its extension).
  async getText(pathOrUrl, { headers = {}, method = "GET", body, fixture, cacheTtlMs } = {}) {
    const url = this._url(pathOrUrl);
    const options = { method, headers: { ...this.defaultHeaders, ...headers }, body };

    if (this.fixtureMode) {
      const name = fixture ?? (this.fixtureResolver && this.fixtureResolver(url, options));
      if (!name) {
        throw new UpstreamError("fixtureMode is on but no fixture name was resolved", {
          details: { url, method },
        });
      }
      return loadLegalTextFixture(name);
    }

    const key = `TEXT ${this._cacheKey(url, options)}`;
    if (this.cache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    const text = await this._fetchTextWithRetry(url, options);
    if (this.cache) this.cache.set(key, text, cacheTtlMs ?? this.cacheTtlMs);
    return text;
  }

  // Mirror of base _fetchWithRetry but reads res.text() instead of res.json().
  async _fetchTextWithRetry(url, options) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.rateLimiter) await this.rateLimiter.take();
      try {
        return await this._fetchTextOnce(url, options);
      } catch (err) {
        lastErr = err;
        if (!this._isRetriable(err) || attempt === this.maxRetries) throw err;
        let delay;
        if (err instanceof RateLimitError && err.retryAfterMs != null) {
          delay = err.retryAfterMs;
        } else {
          delay = backoffDelay(attempt, { ...this.backoff, rng: this._rng });
        }
        await this._sleep(delay);
      }
    }
    throw lastErr;
  }

  async _fetchTextOnce(url, options) {
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
      throw new RateLimitError("upstream rate limited (429)", { status: 429, retryAfterMs: retryAfter, details: { url } });
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
      return await res.text();
    } catch (err) {
      throw new UpstreamError("failed to read text response", { cause: err, details: { url } });
    }
  }
}

// Resolve an API key from the environment with a documented, no-key fallback.
// All of these APIs work key-less for low-volume read access; a key (where the
// service offers one, e.g. govinfo/DATA.gov, CourtListener) simply raises the
// rate limit. NEVER hardcode a key — read it from `envVar`, else return null.
export function apiKeyFromEnv(envVar) {
  const v = envVar ? process.env[envVar] : undefined;
  return v && String(v).trim() ? String(v).trim() : null;
}
