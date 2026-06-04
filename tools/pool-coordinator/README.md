# @prana/pool-coordinator — pool coordinator skeleton (XX18 + PR8)

The open-source **front end** anyone can run that collects verified shares from workers,
batches them per epoch, and settles them into the **one** on-chain `UnifiedSharesLedger`.

This is a **runnable skeleton**: real stratum and the on-chain broadcast are stubbed, but
share collection, validation, dedup, epoch batching, and the on-chain settle shape are real
and unit-tested.

## §13 — many coordinators, one ledger (the model)

The shares ledger is **baked into the protocol** (`UnifiedSharesLedger`). There is exactly
**one** canonical pool, pinned to the chain. A "coordinator" is a **front end, not a separate
pool** — it collects shares, batches them, and settles them into that single ledger. This is
the **Hive/BLURT-front-end + P2Pool model**: many condenser front-ends, one chain of record.

Consequences (straight from the contracts):

- **No custody risk.** The chain pays workers directly on `UnifiedSharesLedger.claim(epoch)`.
  The coordinator holds only a `CREDITOR_ROLE` key that can *credit shares* but never *move
  tokens*. (See `HashLaneCreditor` / `TaskLaneCreditor`.)
- **Coordinators are fungible.** Point a worker at any coordinator; settled shares are safe
  on-chain regardless. (`CoordinatorRegistry` lets anyone run one against a slashable bond.)
- **Fee can't be routed around.** Settlement is on-chain, so the protocol fee is levied at
  settlement, not at the front end — a rogue coordinator can't dodge it.
- **Cross-coordinator dedup.** TASK jobs are deduped via `JobClaimLedger` so the same unit of
  useful work can't be double-credited by two coordinators.

## Two lanes, two trust models

| Lane | Contract | Trust |
|---|---|---|
| **HASH** (microhash PoW) | `HashLaneCreditor.submitBatch` | self-verifying — a PoW share *is* the work; coordinator re-validates off-chain, no attestation |
| **TASK** (AI/scientific) | `TaskLaneCreditor.creditVerified` (after `TaskVerificationGate`) | NOT self-verifying — needs a **K-of-N** verified attestation before it can become shares |

## Endpoint contract (worker ⇄ coordinator)

The sibling worker (`tools/pool-worker`) POSTs shares over HTTP. Shapes:

### `POST /submit-share`
Request body (matches the worker's `{ workerId, lane, proof|result, difficulty }`):
```jsonc
// HASH share
{ "workerId": "w1", "account": "0x..20byte..", "lane": "hash",
  "difficulty": 2000, "nonce": 42, "proof": "0x...." }

// TASK share
{ "workerId": "w1", "account": "0x..", "lane": "task", "difficulty": 1000,
  "result": "<inference output ref>", "jobId": "0x..32byte..", "taskId": "0x..32byte..",
  "attestation": { "claimId": "0x..32byte..", "k": 2, "n": 3,
                   "attestors": [{ "addr": "0x..", "verified": true }, ...] } }
```
Response:
```jsonc
{ "ok": true, "accepted": true,  "lane": "hash", "units": 2, "epoch": 12345 }
{ "ok": true, "accepted": false, "reason": "bad-pow-proof" }   // validation failures
```

### `GET /job?account=0x..&workerId=w1`
Pulls + claims an available AI job for the worker (dedup via the local job registry).
```jsonc
{ "ok": true, "job": { "jobId": "0x..", "spec": {...} }, "attest": { "k": 2, "n": 3 } }
{ "ok": true, "job": null, "fallbackLane": "hash" }   // no AI demand → hash instead (PR3)
```

### `GET /stats`
```jsonc
{ "ok": true, "coin": { "key": "prana", "symbol": "PRANA", "chainId": 108369 },
  "difficulty": 1000, "currentEpoch": 12345, "connectedWorkers": 3,
  "shares": { "accepted": 10, "rejected": 1 },
  "jobs": { "open": 2, "claimed": 1, "settled": 5, "total": 8 } }
```

### `GET /health` → `{ "ok": true, "coin": "PRANA" }`

## Multi-coin (PR8)

`config.mjs` exposes `SUPPORTED_COINS` — PRANA (home chain, chainId 108369) plus Ethash-family
EVM siblings (ETC/Etchash, ETHW). Select with `PRANA_COIN=etc`. Each coin is a config template
(chainId + RPC + the ledger/creditor/registry addresses a deployment fills in); switching coins
is **config, not code**. There is still exactly one ledger **per chain**.

## Run

```bash
cd tools/pool-coordinator
npm start                 # listens on http://127.0.0.1:8645 (the worker's default coord port)
PRANA_COIN=etc npm start  # coordinate an Ethash sibling instead
```
Env knobs: `PRANA_RPC_URL`, `PRANA_LEDGER_ADDR`, `PRANA_HASH_CREDITOR_ADDR`,
`PRANA_TASK_CREDITOR_ADDR`, `PRANA_GATE_ADDR`, `PRANA_COORD_REGISTRY_ADDR`,
`PRANA_JOB_LEDGER_ADDR`, `PRANA_SIGNER_KEY`, `PRANA_EPOCH_LENGTH_SECONDS`,
`PRANA_SHARE_DIFFICULTY`, `PRANA_ATTEST_K`/`PRANA_ATTEST_N`, `PRANA_COORDINATOR_PORT`.

```bash
npm test                  # node:test units (no deps)
```

## What's real vs stubbed (honest)

**Real:** the HTTP surface, share validation (lane routing, vardiff normalization, K-of-N shape
check), job dedup state machine (mirrors `JobClaimLedger`), per-(account,lane) epoch aggregation
with closed-epoch detection and gas-bounded batch splitting, and the **exact** settle-tx shapes
(`submitBatch` / `creditVerified` / `settle` ABIs + arg order verified against the contracts).

**Stubbed (commented in-code):**
- **Stratum / real PoW.** `validateShare` checks a *synthetic* proof (`expectedSyntheticProof`),
  not real Etchash. Real verification drops into the same function unchanged.
- **Attestor verification.** `checkAttestationShape` counts well-formed `verified` attestor
  entries; real signature/stake checks happen in `TaskVerificationGate.attest()` on-chain.
- **On-chain broadcast.** `settle.mjs` builds `{ to, abi, function, args }` descriptors and logs
  them (DRY mode) — there is no `ethers` dependency. Injecting a live signer would broadcast.
- **`batchId` keccak.** A deterministic dependency-free 32-byte hex stands in for
  `keccak256(coordinatorId, epoch, seq)`; the settler swaps in `ethers.solidityPackedKeccak256`.
- **The settlement fee** (`SettlementFeeHook`) is applied on-chain at the ledger, not here.

## Module map

| File | Role | Tested |
|---|---|---|
| `src/config.mjs` | RPC/addresses/signer/epoch + `SUPPORTED_COINS` (PR8) | — |
| `src/server.mjs` | `node:http` endpoints | (via index) |
| `src/share-validator.mjs` | HASH self-verify + TASK K-of-N shape | ✅ unit |
| `src/job-registry.mjs` | AI-job dedup (mirrors `JobClaimLedger`) | ✅ unit |
| `src/epoch-batcher.mjs` | per-epoch aggregation → settle payloads | ✅ unit |
| `src/settle.mjs` | `buildSettleTx()` / `sendSettleTx()` stub | (shape used by tests indirectly) |
| `src/index.mjs` | wire: config → server → epoch-tick settle | runnable |
