// @prana/inference-router — backend descriptors (TASK XX19)
//
// A "backend" is one place the router can send an inference request. Each
// descriptor declares:
//   - name        : stable id (used in logs + the `servedBy` result field)
//   - kind        : 'river' | 'free-api' | 'cloud'   (drives the priority ladder)
//   - priority    : lower number = tried first. The ladder is:
//                     river (10..)  <  free-api (20..)  <  cloud (90..)
//   - healthCheck(): async -> boolean. true == backend is live and willing.
//   - infer(prompt): async -> { text, ... }. The actual inference call.
//
// ⚠️ EVERYTHING BELOW IS A STUB. No real network calls are made. healthCheck()
//    and infer() return DETERMINISTIC SYNTHETIC output so the router + tests are
//    reproducible. Each stub is commented with the REAL backend it stands in for
//    and the API shape a production implementation would wrap.
//
// The router (src/router.mjs) does not care that these are stubs — it only
// depends on the { name, kind, priority, healthCheck, infer } contract, and the
// real implementations can be dropped in later without touching the router.

import { TokenBucket } from './ratelimit.mjs';

// Priority bands. Keep gaps so individual backends can be ordered within a band.
export const PRIORITY = Object.freeze({
  RIVER: 10, // (1) local river nodes — the worker swarm. Cheapest + most aligned.
  FREE_API: 20, // (2) free / community API tiers — rate-limited but free.
  CLOUD: 90, // (3) paid cloud fallback — always last, costs money.
});

// A deterministic synthetic "inference" so tests are reproducible. NOT a model.
// Real backends replace this with the provider's response text.
function synthInfer(backendName, prompt) {
  return { text: `[${backendName}] echo: ${prompt}`, servedBy: backendName };
}

/**
 * Build a STUB river backend (kind: 'river').
 *
 * REAL SHAPE: a node in the Petals/Hivemind "river" (see
 * design/compute/river-join.md + src/river-client.mjs). Hathor/Qwen pulls
 * inference from whichever river nodes are live; healthCheck() would ping the
 * coordinator / the node's heartbeat, infer() would stream tokens through the
 * shard chain. Here it is stubbed.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {boolean} [opts.healthy=true]  stub: force (un)healthy
 * @param {boolean} [opts.fail=false]    stub: force infer() to throw
 */
export function makeRiverBackend(name, opts = {}) {
  const { healthy = true, fail = false, priority = PRIORITY.RIVER } = opts;
  return {
    name,
    kind: 'river',
    priority,
    // STUB: real impl pings the river coordinator / node heartbeat.
    async healthCheck() {
      return healthy;
    },
    // STUB: real impl runs the prompt through the node's model shard(s).
    async infer(prompt) {
      if (fail) throw new Error(`${name}: river node dropped mid-inference`);
      return synthInfer(name, prompt);
    },
  };
}

/**
 * Build a STUB free-API backend (kind: 'free-api') with a token bucket.
 *
 * REAL SHAPE: a free/community inference tier — e.g. a HuggingFace Inference
 * API free tier, an OpenRouter free model, a community-hosted Ollama/vLLM
 * endpoint. These have hard rate limits, so each carries a TokenBucket; when it
 * is empty the router treats the backend as "ratelimited" and falls through.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {boolean} [opts.healthy=true]
 * @param {boolean} [opts.fail=false]
 * @param {number}  [opts.capacity=5]      bucket size (burst)
 * @param {number}  [opts.refillPerSec=1]  tokens added per second
 * @param {TokenBucket} [opts.bucket]      inject a bucket (for tests)
 */
export function makeFreeApiBackend(name, opts = {}) {
  const {
    healthy = true,
    fail = false,
    priority = PRIORITY.FREE_API,
    capacity = 5,
    refillPerSec = 1,
  } = opts;
  const bucket = opts.bucket ?? new TokenBucket({ capacity, refillPerSec });
  return {
    name,
    kind: 'free-api',
    priority,
    bucket, // exposed so the router/tests can inspect remaining tokens.
    // STUB: real impl might HEAD/ping the provider status endpoint.
    async healthCheck() {
      return healthy;
    },
    // STUB: real impl POSTs to the free-tier inference endpoint.
    async infer(prompt) {
      if (fail) throw new Error(`${name}: free-tier 503`);
      return synthInfer(name, prompt);
    },
  };
}

/**
 * Build a STUB cloud backend (kind: 'cloud') — the final paid fallback.
 *
 * REAL SHAPE: a paid/cloud provider (Anthropic, OpenAI, a managed vLLM cluster).
 * Tried LAST because it costs money; assumed always healthy + high-limit. A real
 * impl still wants a bucket to cap spend, but the default here is generous.
 *
 * @param {string} name
 * @param {object} [opts]
 */
export function makeCloudBackend(name, opts = {}) {
  const {
    healthy = true,
    fail = false,
    priority = PRIORITY.CLOUD,
    capacity = 1000,
    refillPerSec = 100,
  } = opts;
  const bucket = opts.bucket ?? new TokenBucket({ capacity, refillPerSec });
  return {
    name,
    kind: 'cloud',
    priority,
    bucket,
    async healthCheck() {
      return healthy;
    },
    // STUB: real impl calls the paid provider SDK.
    async infer(prompt) {
      if (fail) throw new Error(`${name}: cloud provider error`);
      return synthInfer(name, prompt);
    },
  };
}

/**
 * A reasonable DEFAULT ladder of stub backends, ordered by priority:
 *   river-1, river-2  →  free-api-1, free-api-2  →  cloud-1
 * Useful as a demo / for an end-to-end smoke. All stubbed + healthy.
 */
export function defaultBackends() {
  return [
    makeRiverBackend('river-1', { priority: PRIORITY.RIVER }),
    makeRiverBackend('river-2', { priority: PRIORITY.RIVER + 1 }),
    makeFreeApiBackend('free-hf', { priority: PRIORITY.FREE_API, capacity: 5, refillPerSec: 1 }),
    makeFreeApiBackend('free-openrouter', {
      priority: PRIORITY.FREE_API + 1,
      capacity: 10,
      refillPerSec: 2,
    }),
    makeCloudBackend('cloud-paid', { priority: PRIORITY.CLOUD }),
  ];
}
