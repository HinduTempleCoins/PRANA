# @prana/pool-worker — the auto-switching worker daemon (SS1 / XX17 + PR9 vardiff)

The GridCoin-style agent a PRANA contributor runs. It connects to a **coordinator**, keeps
its working unit (CPU / GPU / ASIC / FPGA) **never idle**, and submits **shares**:

- **HASH lane** — a microhash (Etchash) heartbeat. Self-evidently work; the coordinator
  re-validates the PoW share off-chain.
- **TASK lane** — useful AI / scientific compute. Adversarial-by-default: a result is gated
  K-of-N by `TaskVerificationGate` before any credit is minted (a forged TASK share is worth
  a real HASH share, so the daemon never self-certifies).

Both lanes pool into the **same on-chain ledger at equal weight** (`UnifiedSharesLedger`,
`HashTaskWeightConfig` HASH=TASK=1e18 by default), so the worker is *indifferent* to which
lane it is in — that indifference is what makes lane-switching seamless.

This is the off-chain client described in `design/compute/switching-worker.md` (vault). It
submits to a coordinator (`design/compute/coordinator.md`); it **never** holds a
`CREDITOR_ROLE` key and **never** calls `creditShares` directly.

## Run

```bash
cd tools/pool-worker
npm start                 # = node src/index.mjs
npm test                  # node --test test/  (vardiff + switcher unit tests)
```

No dependencies — **Node ≥ 20 built-ins only** (`node:test`, `node:os`, `node:crypto`,
`fetch`). No `npm install` needed.

### Configure (env vars, all optional)

| Env | Default | Meaning |
|---|---|---|
| `PRANA_COORDINATOR_URL` | `http://127.0.0.1:8645` | coordinator RPC (the only write path) |
| `PRANA_WORKER_ADDR` | dev addr | beacon-bound payout address (all credit keyed to it) |
| `PRANA_WORKER_ID` | `prana-worker-dev` | label for heartbeat/logs |
| `PRANA_HW_PROFILE` | `cpu` | `cpu` \| `gpu` \| `asic` \| `fpga` |
| `PRANA_LANE_PREF` | `auto` | `task` \| `hash` \| `auto` (auto = task-first) |
| `PRANA_FREE_TIER` | `false` | Colab/Kaggle mode — TASK-only, never hashes (ToS) |
| `PRANA_VARDIFF_TARGET_SECONDS` | `15` | target seconds per HASH share (vardiff goal) |
| `PRANA_POLL_INTERVAL_MS` | `1000` | loop cadence |
| `PRANA_SWITCH_COOLDOWN_MS` | `2000` | hysteresis — anti-thrash on bursty task queues |

## Module layout (matches the spec §1)

```
src/
├── config.mjs          coordinator URL, worker id, HW profile, lane prefs, vardiff target
├── hardware.mjs        capability set {canHash, canTask} per profile (the honest HW map, §2)
├── vardiff.mjs         (PR9) per-worker variable difficulty — pure fn + stateful controller
├── hash-lane.mjs       STUB microhash loop -> synthetic share at the vardiff-set rate
├── task-lane.mjs       STUB AI-job runner -> deterministic result + attestation payload
├── switcher.mjs        THE arbiter: task-first, hash fallback, recover (graceful degradation)
├── coordinator-rpc.mjs the only write path: getWork/submitHashShare/tryClaimTask/... (fetch)
└── index.mjs           wire: load config -> detect HW -> loop(switch -> work -> submit)
test/
├── vardiff.test.mjs    converges to target cadence; respects bounds
└── switcher.test.mjs   prefers task, degrades to hash, recovers; capability honesty
```

## Share → on-chain credit mapping (real shapes)

| Lane | daemon produces | coordinator settles via | ledger lane |
|---|---|---|---|
| HASH | `{worker, lane:'HASH', units:1, nonce, difficulty}` | `HashLaneCreditor.submitBatch(epoch, batchId, workers[], hashShares[])` | `Lane.HASH` |
| TASK | `{worker, lane:'TASK', claimId, taskId, baseShares, attestation}` | (K-of-N `TaskVerificationGate`) → `TaskLaneCreditor.creditVerified(claimId, taskId, baseShares)` | `Lane.TASK` |

Payout is **async**: earnings are not paid per share. After an epoch closes the worker (or a
keeper) calls `UnifiedSharesLedger.claim(epoch)` for its pro-rata PPLNS payout.

## What is REAL vs STUBBED (kept honest)

**Real (and unit-tested):**
- the control flow / lifecycle / graceful shutdown (`index.mjs`),
- the **vardiff** math — converges a worker to a steady share cadence regardless of hardware
  size, clamped to governed `[min,max]` difficulty bounds (`vardiff.mjs`),
- the **lane-switch** arbiter — task-first preference, hash fallback (never idle), recovery
  with hysteresis, and capability honesty (`switcher.mjs`),
- the **share / submission shapes** that map onto the real `HashLaneCreditor` /
  `TaskLaneCreditor` / `IUnifiedSharesLedger` surfaces,
- the coordinator RPC method surface (`coordinator-rpc.mjs`, built-in `fetch`).

**Stubbed (clearly commented in-file):**
- the actual proof-of-work (`hash-lane.mjs` synthesizes a share whose solve time tracks
  difficulty so vardiff can converge — no Ethash/CUDA),
- the actual AI compute (`task-lane.mjs` deterministically hashes the job spec — no model),
- hardware autodetect beyond CPU core count (GPU/ASIC presence is *declared*, not probed),
- the on-chain reads of `HashTaskWeightConfig.min/maxDifficulty` (dev defaults stand in),
- there is no live coordinator unless one is running (the loop backs off on a dead RPC).

## How the two pure pieces are tested

- **vardiff** (`test/vardiff.test.mjs`): `adjustDifficulty` raises difficulty when shares
  come too fast and lowers it when too slow, and clamps to `[min,max]`. The stateful
  `VardiffController` is driven through a closed-loop simulation (`solveTime = difficulty /
  hashrate`) for both a fast GPU and a weak CPU and asserted to **converge** so the implied
  cadence approaches the 15 s target (verified to land within ±1.5 s; numerically ~15.0 s).
- **switcher** (`test/switcher.test.mjs`): the pure `decideLane` covers prefer-task,
  degrade-to-hash, no-preempt-in-flight, forced-hash, hash-only-never-tasks, and
  ASIC-idles-when-no-task. The stateful `Switcher` (with an **injected clock**) is run
  through a full **prefer → degrade → recover** cycle asserting the hysteresis cooldown.

All timers are `.unref()`'d (and the switcher/clock are injectable), so `node:test` exits
cleanly with no hanging handles.
