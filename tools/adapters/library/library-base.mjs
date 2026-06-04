// library-base.mjs — shared glue for the public-domain / library API adapters.
//
// These adapters (Gutendex, Internet Archive, Open Library, Wayback) are all
// READ-ONLY clients over public, key-less library/archive APIs. They reuse the
// W9 adapter base in ../base.mjs verbatim (HttpClient: retry + full-jitter
// backoff, token-bucket rate limit, TTL cache, typed errors, fixture mode) —
// same constructor shape, same fixture-mode fallback, same typed-error taxonomy
// as the W2/W3 CoinGecko/DefiLlama adapters and the SB-B legal adapters.
//
// The only thing this file adds is a fixture loader that reads recorded JSON
// from THIS folder's ./fixtures/ (so each adapter's fixtures sit next to it),
// rather than the central tools/adapters/fixtures/ dir that base.loadFixture
// targets. Everything else is the unchanged base layer.
//
// Scope note: these wrap PUBLIC APIs only. They do not re-host content; where an
// API points at a captured/copyrighted resource (e.g. Wayback), the adapter
// returns a POINTER (the upstream URL / capture timestamp) and never proxies or
// stores the bytes. See ../../design/library/tier-routing-spec.md.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { HttpClient, UpstreamError } from "../base.mjs";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

// Same semantics as base.loadFixture, but rooted at library/fixtures/. Throws an
// UpstreamError when a fixture is missing so a forgotten recording fails loudly
// instead of silently hitting the network.
export async function loadLibraryFixture(name) {
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

// HttpClient that serves fixtures from library/fixtures/. Identical to the base
// HttpClient in every other respect (retry, rate limit, cache, typed errors);
// it only overrides the fixture-mode branch of getJson to use the local loader.
export class LibraryHttpClient extends HttpClient {
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
      return loadLibraryFixture(name);
    }
    return super.getJson(pathOrUrl, { headers, method, body, fixture, cacheTtlMs });
  }
}

// Resolve an API key from the environment with a documented, no-key fallback.
// Every API wrapped here works key-less for low-volume read access; a key (where
// the service offers one) simply raises the rate limit. NEVER hardcode a key —
// read it from `envVar`, else return null.
export function apiKeyFromEnv(envVar) {
  const v = envVar ? process.env[envVar] : undefined;
  return v && String(v).trim() ? String(v).trim() : null;
}
