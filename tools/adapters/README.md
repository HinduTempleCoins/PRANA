# PRANA data adapters

Plain-ESM (no framework, no build step) data adapters consumed by the wallet
and the aggregator. Each adapter is a thin, typed client over one upstream:
the PRANA RPC node, or a public read-only data API. They all share one base
layer so retries, rate limiting, caching, error types, and offline test
fixtures behave identically everywhere.

## Layering

```
            ┌─────────────────────────────────────────────┐
 consumers  │   the wallet  /  the aggregator              │
            └───────────────┬─────────────────────────────┘
                            │ import typed clients
            ┌───────────────┴─────────────────────────────┐
 adapters   │  rpc.mjs   coingecko.mjs   defillama.mjs     │
            └───────────────┬─────────────────────────────┘
                            │ all build on
            ┌───────────────┴─────────────────────────────┐
 base       │  base.mjs                                    │
            │   • AdapterError / RateLimitError /          │
            │     UpstreamError  (typed taxonomy)          │
            │   • HttpClient: retry + full-jitter backoff, │
            │     token-bucket rate limit, TTL cache,      │
            │     fixtureMode                              │
            │   • TokenBucket, TTLCache, loadFixture       │
            └─────────────────────────────────────────────┘
```

### `base.mjs` (W9)

- **Typed errors.** `AdapterError` (base), `RateLimitError` (429 / limiter
  refusal, carries `retryAfterMs`), `UpstreamError` (non-OK HTTP or parse
  failure, carries `status`). Consumers branch on the class, not on strings.
- **`HttpClient.getJson()`** — the workhorse. In order: honour fixture mode →
  serve from TTL cache → wait on the rate limiter → fetch with retry +
  exponential backoff with full jitter on transient failures (network error,
  429, 5xx) → map failures to typed errors → cache successful JSON. 4xx
  (except 429) is non-retriable.
- **`TokenBucket`** — simple token-bucket limiter; `now`/`sleep` injectable.
- **`TTLCache`** — Map-based TTL cache with insertion-order eviction.
- Everything time/network/random is **injectable** (`fetchImpl`, `sleep`,
  `rng`, `now`) so the whole layer is unit-testable offline.

### `rpc.mjs` (W1)

RPC client over **ethers v6** `JsonRpcProvider`, defaulting to PRANA local RPC
`http://127.0.0.1:8545`, chainId **108369** (`0x1a751`). Passthroughs:
`getBlockNumber`, `getBlock`, `getBalance` (returns `bigint` wei),
`getTransaction`, `call`, `sendRawTransaction` — each wrapped with the base
retry policy and typed-error mapping (`mapEthersError`). For tests it ships a
**`FixtureProvider`** implementing the minimal provider surface from a JSON
fixture, so no node is required.

### `coingecko.mjs` (W2)

Typed client for `GET /simple/price` and `GET /coins/markets` (free-tier
paths). Cached + rate-limited via base. Optional API key is sent as the
`x-cg-demo-api-key` header when provided. Returns shaped/typed objects (see
`simplePrice` → `{ prices, raw }`, `coinsMarkets` → typed rows); `priceOf()`
is a convenience accessor.

### `defillama.mjs` (W3)

Read-only, no key. TVL via `GET /protocols` and `GET /v2/chains`
(`api.llama.fi`), yields via `GET /pools` (`yields.llama.fi`). Two
`HttpClient`s (one per host) share the same base policy. Returns typed rows.

### `legal/` — SoapBox legal/government adapters (BB2-1..7)

Seven READ-ONLY clients over public US legal/government APIs, in `legal/`. They
reuse the same W9 base (`../base.mjs`) for retry/rate-limit/cache/typed-errors,
plus a thin `legal/legal-base.mjs` (`LegalHttpClient`) that serves fixtures from
`legal/fixtures/` (next to the adapters) and adds a `getText()` for XML payloads.
Optional API keys are read from env (never hardcoded) with documented fallbacks.

| Module                 | Upstream (public, read-only)            | Methods                                        | Key env (fallback)            |
| ---------------------- | --------------------------------------- | ---------------------------------------------- | ----------------------------- |
| `courtlistener.mjs`    | CourtListener API v4                    | `search`, `getOpinion`, `getDocket`            | `CL_API_TOKEN` (null)         |
| `caselaw-access.mjs`   | Caselaw Access Project (Harvard)        | `search`, `getCase`                            | `CAP_API_KEY` (null)          |
| `govinfo.mjs`          | govinfo.gov (USC/CFR/bills)             | `search`, `getPackage`, `getGranules`          | `GOVINFO_API_KEY`→`DATA_GOV_API_KEY`→`DEMO_KEY` |
| `uscode-uslm.mjs`      | uscode.house.gov USLM XML               | `getTitle`, `fetchDocument`, `searchInDocument`| none (public)                 |
| `ecfr.mjs`             | eCFR API                                | `search`, `getTitleStructure`, `getAgencies`   | none (public)                 |
| `federal-register.mjs` | Federal Register API                    | `search`, `getDocument`                        | none (public)                 |
| `recap.mjs`            | RECAP Archive (read-only, no PACER)     | `search`, `getDocketEntries`, `getDocument`    | `CL_API_TOKEN` (null)         |

⚠️ `recap.mjs` is RECAP-Archive-read-only by design; paid PACER fetch/purchase is
explicitly OUT OF SCOPE (see the in-file note). Tests: `node --test
tools/adapters/legal/legal-adapters.test.mjs` (20 offline tests — parsed records,
pagination shape, error handling).

## Fixture convention

Recorded JSON lives in `fixtures/<name>.json`. A client constructed with
`fixtureMode: true` serves these instead of fetching; a missing fixture throws
`UpstreamError` (fail loud, never silently hit the network). Names used:

| Fixture                              | Served for                       |
| ------------------------------------ | -------------------------------- |
| `coingecko-simple-price.json`        | CoinGecko `/simple/price`        |
| `coingecko-coins-markets.json`       | CoinGecko `/coins/markets`       |
| `defillama-protocols.json`           | DefiLlama `/protocols`           |
| `defillama-chains.json`              | DefiLlama `/v2/chains`           |
| `defillama-pools.json`               | DefiLlama `/pools`               |
| `rpc-basic.json`                     | `FixtureProvider` (RPC tests)    |

Payloads are hand-written realistic samples. To record a new real payload,
drop the JSON response into `fixtures/<name>.json`.

## How the wallet / aggregator consumes these

```js
import { RpcClient } from "./tools/adapters/rpc.mjs";
import { CoinGeckoClient } from "./tools/adapters/coingecko.mjs";
import { DefiLlamaClient } from "./tools/adapters/defillama.mjs";

const rpc = new RpcClient();                 // PRANA local node, chainId 108369
const bal = await rpc.getBalance(addr);      // bigint wei

const cg  = new CoinGeckoClient();           // add { apiKey } if you have one
const px  = await cg.simplePrice({ ids: ["ethereum"], vsCurrencies: ["usd"] });

const dl  = new DefiLlamaClient();
const tvl = await dl.chains();
```

Catch `RateLimitError` / `UpstreamError` / `AdapterError` to drive retry/backoff
UX. Pass a shared `TTLCache` / `TokenBucket` into multiple clients if you want
one global budget.

## Dependencies

Reuses `ethers` v6 from the repo's `contracts/node_modules` via a `node_modules`
symlink (`../../contracts/node_modules`) plus `package.json` `{"type":"module"}`.
No npm install, no network access in tests.

## Tests

```
node --test tools/adapters/
```

`base.test.mjs` (retry/backoff with an injected clock, rate limit, cache TTL,
fixture mode), `rpc.test.mjs` (FixtureProvider + error mapping),
`coingecko.test.mjs`, `defillama.test.mjs` (fixture parsing + typed-shape +
error mapping). All offline.
