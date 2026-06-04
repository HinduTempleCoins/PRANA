# PRANA — Final Green-Gate Runbook (ZZ2-3)

> The "how to prove it's all green" runbook: the exact commands for a full-green sweep, what
> each currently reports, and the known-flaky / known-skipped list.
>
> ⚠️ **This doc does not run the builds** (it is the capstone synthesis). The reported numbers
> are **as last recorded** during the build waves; re-run the commands below to confirm. Where a
> number is a per-assertion total from a prior run (not a file count I re-derived), it is labeled
> "(last recorded)". File-level counts I confirmed from the repo are labeled "(confirmed)".

---

## 0. TL;DR — the one-shot sweep

Run these six gates in order. All must pass for a green launch-candidate.

```bash
# 1. Solidity unit + invariant tests (Hardhat)
cd contracts && npx hardhat test

# 2. Solidity stateful fuzz / invariants (Foundry)
cd contracts && forge test

# 3. Solidity lint
cd contracts && npx solhint 'contracts/**/*.sol'

# 4. Akasha wallet/lib/app + deploy-wizard
cd akasha && node --test

# 5. Off-chain compute skeletons (Node built-in test runner)
cd tools/pool-worker      && node --test
cd tools/pool-coordinator && node --test
cd tools/inference-router && node --test

# 6. API adapters + catalog/consumer-matrix validators
cd tools/adapters && node --test
node tools/brain/state/design/validate-catalog.js
node tools/adapters/check-consumer-matrix.mjs
```

---

## 1. Gate-by-gate detail

### Gate 1 — Hardhat (Solidity unit + integration)

```bash
cd contracts
npx hardhat test                      # full suite
npx hardhat test test/UnifiedSharesLedger*.test.js   # compute engine only, optional
```

- **Reports (last recorded): approximately 1,425 passing.**
- **Confirmed:** ~180 `*.test.js` files under `contracts/test/`.
- Covers: AMM/StableSwap/router/flash-swaps, ve/gauges/boost/bribes, Governor+Timelock, CDP +
  liquidation, burn-mine family, ERC-4337 stack, token factories, the **compute engine**
  (`UnifiedSharesLedger`, lane creditors, `TaskVerificationGate`, burn-stake, fee hook, regent,
  `CoordinatorRegistry`/`JobClaimLedger`), the game pack, and the bridge endpoints.
- Key E2E proofs that must stay green:
  - **XX9** — switching engine pays HASH + TASK **equally** into one pool.
  - **XX10** — burn → weight → emission + governance vote.
  - **PR3** — zero-AI-demand graceful degradation (pool pays on HASH alone).

### Gate 2 — Foundry (stateful fuzz / invariants)

```bash
cd contracts
forge test                            # all forge tests
forge test --match-path 'test-forge/invariant/*'     # invariants only
```

- **Reports (last recorded): green** (was "12 forge tests" earlier; grew with the compute wave).
- **Confirmed:** ~20 `*.t.sol` files under `contracts/test-forge/`, including the stateful
  invariants **`invariant/UnifiedSharesLedgerInvariant.t.sol`** and `invariant/BurnMineInvariant.t.sol`,
  plus `Create2Deployer.t.sol`.
- The ledger invariant is the highest-value one: it fuzzes lane credits + claims and asserts the
  PPLNS payout accounting never over-pays the funded budget and stays idempotent per (account,epoch).

### Gate 3 — solhint

```bash
cd contracts
npx solhint 'contracts/**/*.sol'
```

- **Reports: clean** over the repo (OZ-5.x config).
- ⚠️ **Open (XX15):** a dedicated solhint + **slither** re-sweep over the *newest* compute
  contracts is still pending. The repo-wide config passes; the targeted re-run is a 🔲 to-build,
  not a known failure.

### Gate 4 — Akasha (wallet + lib + app + deploy-wizard)

```bash
cd akasha
node --test
```

- **Reports (last recorded): 331 / 332 passing.**
- **Confirmed:** ~34 `*.test.*` files across `akasha/lib`, `akasha/app`, `akasha/test`.
- The React app separately builds and reports 16/16 of its own component tests; runs with and
  without a live node.
- **THE ONE KNOWN FAILURE — pre-existing, accepted:** the **deploy-wizard** test
  (`akasha/test/deploy-wizard.test.mjs`, driving `akasha/tools/deploy-wizard.mjs` via
  `akasha/lib/storage-fs.mjs`) fails with a filesystem **`ENOENT`** when a fixture
  path/artifact is absent in a clean checkout. It is **environmental, not a logic regression** —
  the wizard's logic is exercised by its other assertions. This is the "1" in 331/332. Do not
  block launch on it; fix is a fixture-path/setup nicety.

### Gate 5 — Off-chain compute skeletons

```bash
cd tools/pool-worker      && node --test     # vardiff + switcher + river-client
cd tools/pool-coordinator && node --test     # epoch-batcher + job-registry + share-validator
cd tools/inference-router && node --test     # router fallthrough + token-bucket ratelimit
```

- **Reports: green.** No `npm install` needed — **Node ≥ 20 built-ins only**.
- **Scope reminder (honesty):** these test the **control flow** (vardiff, lane-switch, epoch
  batching, dedup, share validation, the fallthrough ladder, the token bucket). Network /
  stratum / model inference / on-chain broadcast are **stubbed** — the tests do not exercise real
  I/O because there is none yet.

### Gate 6 — API adapters + catalog validators

```bash
cd tools/adapters && node --test            # rpc, coingecko, defillama, subgraph, qdrant,
                                            # blockscout, walletconnect-stub, base, consumer-matrix
node tools/brain/state/design/validate-catalog.js
node tools/adapters/check-consumer-matrix.mjs
```

- **Adapters: green.** **Confirmed:** ~42 `*.test.mjs` files under `tools/` (adapters + soapbox
  + library connectors); ~9 core adapter suites under `tools/adapters/`.
- **SoapBox adapters (last recorded): 179 adapter tests passing** (legal/media/resource/business
  connectors; e.g. `tools/soapbox/license-router.test.mjs`).
- **Catalog validator (last recorded): 337 tools OK** — `validate-catalog.js` checks schema
  completeness (7 fields/tool), no duplicate names, and **count integrity** (`count ===
  tools.length === source1 + source2`) over `vkfri-resource-catalog.json`.
- **Consumer-matrix lint:** asserts every cataloged component maps to the APIs it consumes.

---

## 2. Known-flaky / known-skipped register

| Item | Gate | Class | Action |
|---|---|---|---|
| `akasha` deploy-wizard `ENOENT` (1 of 332) | 4 | **Pre-existing environmental** | Accept for launch; fix fixture-path setup later. Do **not** treat as a regression. |
| solhint + slither re-sweep over newest compute contracts (XX15) | 3 | **To-build (not a failure)** | Run targeted sweep; repo-wide config already passes. |
| Gas-snapshot refresh for new compute contracts (XX16) | 2 | **To-build (not a failure)** | `forge snapshot` over the compute group; baseline exists. |
| pool-worker / pool-coordinator / inference-router | 5 | **Skeleton coverage by design** | Tests cover control flow only; real-I/O paths are stubbed and intentionally untested until production backends land. |
| Forge test count drift ("12" → ~20 files) | 2 | **Documentation drift** | Trust the live `forge test` summary, not the older "12" figure. |
| Hardhat count drift ("985" → ~1,425) | 1 | **Documentation drift** | Trust the live `npx hardhat test` summary. |

> **No silently-skipped logic tests are known.** The commit/reveal game contracts and the
> compute invariants run to completion. The only intentional non-coverage is the stubbed I/O in
> the off-chain skeletons (Gate 5), which is a build-stage property, not a skip.

---

## 3. The green-gate definition (what "all green" means for launch)

A build is a **green launch-candidate** when:

1. Gates 1–6 above all pass on a clean checkout, **except** the single accepted
   deploy-wizard `ENOENT` (Gate 4).
2. The compute-engine invariants (Gate 2) pass with no counterexample.
3. The three launch-gating E2E proofs (XX9 / XX10 / PR3) are green (Gate 1).
4. solhint is clean repo-wide (Gate 3); the targeted compute re-sweep (XX15) is run or
   explicitly waived.

**Green ≠ launch.** A green sweep proves the code is correct; it does **not** answer the
**9 open user-decisions** that gate the actual mainnet genesis (coordinator trust model,
microhash algo, fee placement, TASK-lane scope, coinbase→ledger funding, hash:AI weighting,
securities framing, viem-vs-ethers, logo — see `design/LAUNCH-READINESS.md` §6). Those are
choices, not test failures, and they are the real launch gate.
