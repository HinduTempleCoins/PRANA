// base.test.mjs — offline unit tests for the shared adapter layer (W9).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AdapterError,
  RateLimitError,
  UpstreamError,
  TokenBucket,
  TTLCache,
  HttpClient,
  backoffDelay,
  parseRetryAfter,
  loadFixture,
} from "./base.mjs";

// ---- a controllable fake clock --------------------------------------------
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    // A sleep that advances the same clock, so token-bucket refills "happen".
    sleep: async (ms) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

// ---- errors ---------------------------------------------------------------
test("error classes carry type, status, retryAfter", () => {
  const a = new AdapterError("x", { details: { k: 1 } });
  assert.equal(a.name, "AdapterError");
  assert.equal(a.details.k, 1);

  const r = new RateLimitError("slow", { retryAfterMs: 1500 });
  assert.ok(r instanceof AdapterError);
  assert.equal(r.retryAfterMs, 1500);

  const u = new UpstreamError("boom", { status: 503 });
  assert.ok(u instanceof AdapterError);
  assert.equal(u.status, 503);
});

// ---- backoff --------------------------------------------------------------
test("backoffDelay grows exponentially and respects cap + rng", () => {
  // rng pinned to 1 => full window (minus floor rounding).
  const rng = () => 0.999999;
  const d0 = backoffDelay(0, { baseMs: 100, capMs: 10000, rng });
  const d1 = backoffDelay(1, { baseMs: 100, capMs: 10000, rng });
  const d2 = backoffDelay(2, { baseMs: 100, capMs: 10000, rng });
  assert.ok(d0 < d1 && d1 < d2, "delays should grow");
  // Cap kicks in.
  const dHigh = backoffDelay(20, { baseMs: 100, capMs: 500, rng });
  assert.ok(dHigh <= 500);
  // rng=0 => zero delay (full jitter floor).
  assert.equal(backoffDelay(5, { baseMs: 100, rng: () => 0 }), 0);
});

test("parseRetryAfter handles seconds and ignores dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), null);
});

// ---- token bucket ---------------------------------------------------------
test("TokenBucket: capacity, refill, and tryTake", () => {
  const clk = fakeClock(0);
  const tb = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clk.now });
  assert.equal(tb.tryTake(), true);
  assert.equal(tb.tryTake(), true);
  assert.equal(tb.tryTake(), false, "bucket empty");
  // 1s later -> 1 token back.
  clk.advance(1000);
  assert.equal(tb.tryTake(), true);
  assert.equal(tb.tryTake(), false);
});

test("TokenBucket.take() waits using injected sleep then succeeds", async () => {
  const clk = fakeClock(0);
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 2, now: clk.now, sleep: clk.sleep });
  await tb.take(); // consumes the one token immediately
  const before = clk.t;
  await tb.take(); // must wait ~500ms for refill at 2/sec
  assert.ok(clk.t >= before + 400, `should have advanced clock (was ${clk.t - before}ms)`);
});

// ---- TTL cache ------------------------------------------------------------
test("TTLCache: hit, expiry, and insertion-order eviction", () => {
  const clk = fakeClock(0);
  const c = new TTLCache({ ttlMs: 1000, now: clk.now, maxEntries: 2 });
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.has("a"), true);

  clk.advance(1001);
  assert.equal(c.get("a"), undefined, "expired");
  assert.equal(c.has("a"), false);

  // eviction
  c.set("x", 1);
  c.set("y", 2);
  c.set("z", 3); // evicts oldest (x)
  assert.equal(c.get("x"), undefined);
  assert.equal(c.get("y"), 2);
  assert.equal(c.get("z"), 3);
});

// ---- fixture loading ------------------------------------------------------
test("loadFixture serves recorded JSON and throws on missing", async () => {
  const data = await loadFixture("coingecko-simple-price");
  assert.equal(data.bitcoin.usd, 67234.0);
  await assert.rejects(() => loadFixture("does-not-exist-xyz"), (e) => {
    assert.ok(e instanceof UpstreamError);
    assert.match(e.message, /fixture missing/);
    return true;
  });
});

// ---- HttpClient: fixture mode --------------------------------------------
test("HttpClient fixtureMode serves fixture and never fetches", async () => {
  let fetched = false;
  const http = new HttpClient({
    fixtureMode: true,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("should not be called");
    },
  });
  const out = await http.getJson("/whatever", { fixture: "coingecko-simple-price" });
  assert.equal(out.ethereum.usd, 3512.77);
  assert.equal(fetched, false);
});

test("HttpClient fixtureMode without a resolver/fixture throws", async () => {
  const http = new HttpClient({ fixtureMode: true });
  await assert.rejects(() => http.getJson("/x"), UpstreamError);
});

// ---- HttpClient: retry + backoff with injected sleep ----------------------
test("HttpClient retries on 5xx then succeeds; counts attempts", async () => {
  const clk = fakeClock(0);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) {
      return { ok: false, status: 503, text: async () => "busy" };
    }
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  const http = new HttpClient({
    maxRetries: 5,
    fetchImpl,
    sleep: clk.sleep,
    rng: () => 0.5,
    backoff: { baseMs: 10, capMs: 100 },
  });
  const out = await http.getJson("https://x.test/api");
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls, 3, "two failures then success");
  assert.ok(clk.t > 0, "slept between retries");
});

test("HttpClient does NOT retry 4xx (non-429) and maps to UpstreamError", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 404, text: async () => "nope" };
  };
  const http = new HttpClient({ maxRetries: 5, fetchImpl, sleep: async () => {} });
  await assert.rejects(() => http.getJson("https://x.test/api"), (e) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, 404);
    return true;
  });
  assert.equal(calls, 1, "no retries on 404");
});

test("HttpClient maps 429 to RateLimitError and honours Retry-After", async () => {
  const clk = fakeClock(0);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "3" : null) },
        text: async () => "rl",
      };
    }
    return { ok: true, status: 200, json: async () => ({ done: true }) };
  };
  const http = new HttpClient({ maxRetries: 2, fetchImpl, sleep: clk.sleep, rng: () => 0.5 });
  const out = await http.getJson("https://x.test/api");
  assert.deepEqual(out, { done: true });
  // Retry-After: 3s honoured.
  assert.ok(clk.t >= 3000, `expected >=3000ms slept, got ${clk.t}`);
});

test("HttpClient exhausts retries then throws last error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "err" };
  };
  const http = new HttpClient({ maxRetries: 2, fetchImpl, sleep: async () => {} });
  await assert.rejects(() => http.getJson("https://x.test/api"), UpstreamError);
  assert.equal(calls, 3, "1 initial + 2 retries");
});

// ---- HttpClient: cache + rate limiter integration -------------------------
test("HttpClient serves from cache without a second fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ n: calls }) };
  };
  const cache = new TTLCache({ ttlMs: 10000 });
  const http = new HttpClient({ fetchImpl, cache, sleep: async () => {} });
  const a = await http.getJson("https://x.test/same");
  const b = await http.getJson("https://x.test/same");
  assert.deepEqual(a, b);
  assert.equal(calls, 1, "second call served from cache");
});

test("HttpClient applies the rate limiter (take called per attempt)", async () => {
  const clk = fakeClock(0);
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 1, now: clk.now, sleep: clk.sleep });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  const http = new HttpClient({ fetchImpl, rateLimiter: tb, sleep: clk.sleep });
  await http.getJson("https://x.test/a"); // uses the 1 token
  const before = clk.t;
  await http.getJson("https://x.test/b"); // must wait for refill
  assert.ok(clk.t > before, "rate limiter forced a wait");
});

test("HttpClient wraps a thrown network error as UpstreamError (retriable)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 2) throw new Error("ECONNRESET");
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  const http = new HttpClient({ maxRetries: 3, fetchImpl, sleep: async () => {}, rng: () => 0 });
  const out = await http.getJson("https://x.test/api");
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls, 2);
});
