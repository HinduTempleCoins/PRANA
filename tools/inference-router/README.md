# @prana/inference-router

**TASK XX19** — Free-API fallback inference router for the PRANA AI-work (TASK) lane.

This is the *"Hathor pulls from whichever nodes are live"* router. It routes a
single inference request across a **priority ladder** of backends and **falls
through** on failure or rate-limit, so the AI layer keeps serving even when the
cheapest backends are down.

```
  (1) river nodes        the worker swarm — Petals/Hivemind shard-holders.
        │                cheapest + most aligned. tried FIRST.
        ▼  (fall through on drop / failure)
  (2) free / community    HuggingFace free tier, OpenRouter free model, a
        API tiers          community Ollama/vLLM. free but RATE-LIMITED.
        │                 (token bucket per backend; empty bucket ⇒ skip)
        ▼  (fall through on ratelimit / 503)
  (3) paid cloud          Anthropic / OpenAI / managed vLLM. costs money,
       fallback           so it is ALWAYS LAST. assumed healthy + high-limit.
```

> ⚠️ **Skeleton.** Every backend's `healthCheck()` / `infer()` is **stubbed** to
> return deterministic synthetic output (no network, no real models). What is
> *real and tested* is the control flow: priority ordering, the fallthrough
> machine, and the per-backend token-bucket rate limiter. Drop real
> implementations into `backends.mjs` later without touching the router.

## Layout

| file                  | what it is                                                              |
| --------------------- | ---------------------------------------------------------------------- |
| `src/backends.mjs`    | backend descriptors (`name`, `kind`, `priority`, `healthCheck`, `infer`) — all STUBBED, each commented with the real backend + API shape it stands in for. Factories: `makeRiverBackend`, `makeFreeApiBackend`, `makeCloudBackend`, `defaultBackends`. |
| `src/router.mjs`      | `InferenceRouter` — sorts by priority, walks the ladder, skips ratelimited/unhealthy, returns the first success + `servedBy`. Backends are **injected** ⇒ unit-testable. |
| `src/ratelimit.mjs`   | `TokenBucket` — tiny token-bucket per free-tier backend; injectable clock ⇒ unit-testable. |
| `src/river-client.mjs`| *(see `tools/pool-worker/src/river-client.mjs` — the actual river client stub lives with the worker; TASK XX20.)* |
| `test/`               | `node:test` suites for the router + token bucket.                       |

## Usage

```js
import { createRouter } from '@prana/inference-router/router';
import { defaultBackends } from '@prana/inference-router/backends';

const router = createRouter(defaultBackends());
const res = await router.infer('what is prana?');
// → { text, servedBy: 'river-1', kind: 'river', attempts: [...] }
```

To plug in a **real** backend, implement the contract and inject it:

```js
const realRiver = {
  name: 'river-east', kind: 'river', priority: 10,
  async healthCheck() { /* ping coordinator */ return true; },
  async infer(prompt) { /* run shard chain */ return { text }; },
};
const router = createRouter([realRiver, ...defaultBackends()]);
```

## How the fallthrough is tested (`test/router.test.mjs`)

Backends are injected stubs, so the whole router is exercised with **no network**:

- **priority** — a `cloud` backend is passed *first* in the array but a `river`
  backend (lower `priority`) is the one that serves ⇒ ladder order wins, not array order.
- **fall through on failure** — a river backend whose `infer()` throws is skipped
  and the next backend serves; the `attempts` trail records `failed` then `success`.
- **skip unhealthy** — `healthCheck() → false` (and a *throwing* `healthCheck`) are
  both skipped.
- **skip ratelimited** — a free-api backend with a drained `TokenBucket` is skipped
  without ever calling `infer()`; the next backend serves.
- **full-ladder** — river `failed` → free-api `ratelimited` → cloud `success`, asserted
  as an exact ordered trail (even when backends are passed out of priority order).
- **bucket is charged** — two requests drain a capacity-2 free-api bucket, the third
  falls through to cloud (proves the router actually consumes tokens on success).
- **exhaustion** — every backend failing throws an `AggregateError` carrying the trail.
- **observability** — the `onAttempt` hook fires once per attempt in order.

## How the token bucket is tested (`test/ratelimit.test.mjs`)

A controllable fake clock is injected (`now`), so refill is deterministic with **no
real time and no timers**:

- starts full, consumes tokens, reports `available()`;
- rejects `tryRemove` when empty and removes nothing on the failed call;
- **refills at `refillPerSec` over elapsed time, capped at `capacity`** (drain 5,
  advance 1s ⇒ +2; advance 10s ⇒ capped at 5);
- partial/fractional-second refill;
- `refillPerSec: 0` never refills;
- constructor rejects bad args (`capacity ≤ 0`, `refillPerSec < 0`).

Run: `node --test test/` (Node ≥ 20; built-ins only).
