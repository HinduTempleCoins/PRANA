# Miningcore fork — ONE pool codebase for BOTH chains (Etchash + RandomX)

**Backlog item:** AG12 (Round 9 — the AI / GridCoin doc, §2).
**Status:** architecture / build-direction note. Binds to already-built skeletons + contracts;
no new code here.

> This note picks the *fallback* pool engine and shows how it slots behind the PRANA
> contracts. The **priority** path is the in-chain decentralized pool ([`decentralized-pool.md`](./decentralized-pool.md), PR6);
> Miningcore is the off-chain coordinator that posts verified work to that on-chain ledger
> while verification matures. Both settle into the same `UnifiedSharesLedger`.

---

## 1. The one-line idea — one pool stack, two algorithms

PRANA wants **two** kinds of share to flow into the same on-chain pool:

- the **HASH lane** — a microhash heartbeat that secures/orders blocks (Etchash, the
  Ethash-family PoW the chain forked from core-geth — see [`etchash-vs-ethash.md`](../chain/etchash-vs-ethash.md));
- a **CPU-mineable** stream so ordinary laptops can participate from day one (RandomX —
  see [`cpu-bootstrap.md`](./cpu-bootstrap.md)).

The naive way to run both is to stand up **two** separate pool stacks: an Ethereum-style
stratum pool for the EVM/Etchash side and a CryptoNote/RandomX pool for the CPU side. Two
codebases, two ops surfaces, two sets of bugs.

**We don't do that.** We fork **[oliverw/miningcore](https://github.com/oliverw/miningcore)**
— a single, open-source (mostly MIT/AGPL components), multi-coin pool engine that already
ships **both** stratum families in **one** process:

- an **Ethereum / Ethash-family** stratum (the EVM side → our Etchash microhash lane), and
- a **CryptoNote / RandomX** stratum (the CPU side → the bootstrap lane),

plus Bitcoin-family and Equihash/KawPow families it doesn't matter that we don't use. One
binary, one config file, one payment-processing core, two algorithm front-ends. That is the
whole reason to pick Miningcore over a single-algo pool.

---

## 2. Why Miningcore SUPERSEDES BI25 (open-ethereum-pool)

The earlier research note BI25 / G25 looked at **sammy007/open-ethereum-pool**
(`tools/brain/state/design/research/G25-open-ethereum-pool.md`). It is a clean, well-known
Ethereum-stratum pool — but it is **Ethereum-family only**. It has no RandomX/CryptoNote
stratum, so adopting it would force the exact two-stack split we are trying to avoid: it
covers the EVM side and *nothing* on the CPU side.

**Decision: Miningcore supersedes BI25 as the off-chain pool engine.** It covers *both*
chains' algorithms in one codebase, so a single fork + a single ops surface serves the
Etchash microhash lane **and** the RandomX CPU-bootstrap lane. open-ethereum-pool remains a
useful *reference* for the Ethereum-stratum internals (share validation, the getWork loop),
but it is not the engine we run. (open-ethereum-pool is also effectively unmaintained;
Miningcore is the actively-developed multi-coin option.)

---

## 3. How it maps onto the built pool-coordinator skeleton (XX18)

We already built a runnable coordinator skeleton at `tools/pool-coordinator/` (XX18, with
PR8 multi-coin + PR9 vardiff). Miningcore does **not** replace that — it **plays the role of
the share-source half** that the skeleton's `share-validator.mjs` currently stubs. The clean
seam:

| Concern | Built skeleton (`tools/pool-coordinator/`) | Miningcore fork |
|---|---|---|
| Stratum endpoints (TCP, miner connections) | stubbed (HTTP `/submit-share` for the worker) | **real** — Ethash + RandomX stratum servers |
| Share PoW re-validation | `share-validator.mjs` `expectedSyntheticProof` (synthetic) | **real** Etchash / RandomX verification |
| Vardiff | `PR9` pure controller (`pool-worker/src/vardiff.mjs`) | Miningcore's own per-connection vardiff |
| Per-epoch aggregation → batches | `epoch-batcher.mjs` (real, tested) | Miningcore's share-recording / PPLNS accounting |
| **On-chain settlement** | `settle.mjs` builds the exact `submitBatch` / `creditVerified` / `settle` tx shapes | **(new) a thin PRANA settlement plugin** |
| Custody | none — chain pays workers on `claim()` | none — same |

So the Miningcore fork's job is narrow and well-defined: **terminate real stratum
connections, validate real Etchash/RandomX shares, accumulate them per (account, epoch), and
hand the aggregated, verified HASH-lane batch to the same on-chain settlement shape the XX18
skeleton already encodes.** The settlement descriptor it must emit is the one
`tools/pool-coordinator/src/settle.mjs` already builds:

- `HashLaneCreditor.submitBatch(epoch, batchId, workers[], hashShares[])` for the microhash lane.

It holds the same narrow on-chain authority the skeleton's config documents (`config.mjs`):
a **`CREDITOR_ROLE` key only** — never a token-moving role. Workers are paid directly by the
chain on `UnifiedSharesLedger.claim(epoch)`; the pool engine is never in the value path
(the custody-elimination property of [`decentralized-pool.md`](./decentralized-pool.md) §4).

### The PRANA settlement plugin (the only real new code)

Miningcore's default payment processors *custody* coin and pay miners from a pool wallet.
For PRANA-native issuance we **do not** use that path — we replace it with a settlement
plugin that:

1. takes Miningcore's recorded per-window shares,
2. maps each miner to its **beacon-bound payout `account`** (`WorkerBeaconRegistry`, XX3 —
   the same anti-Sybil address binding the worker daemon uses),
3. buckets them into the on-chain **epoch** (`epoch = timestamp / epochLength`, matching the
   ledger's `EpochManager`/`HashLaneCreditor` math — `config.mjs` `epochLengthSeconds`),
4. emits the `HashLaneCreditor.submitBatch(...)` tx with the coordinator's `CREDITOR_ROLE`
   signer, gas-bounded the same way the skeleton splits batches.

This is the one genuinely new component; everything else is Miningcore's existing,
battle-tested share-handling reused as-is.

### What about the TASK lane?

Miningcore is a **PoW pool** — it knows HASH work, not AI work. The **TASK lane stays where
it already lives**: the worker daemon (`tools/pool-worker`) does AI jobs, the coordinator
skeleton's TASK path routes them through `TaskVerificationGate` (K-of-N) → `TaskLaneCreditor`
([`gridcoin-redirect.md`](./gridcoin-redirect.md)). Miningcore feeds **only** the HASH lane.
So in production the off-chain side is two cooperating processes settling into the one
ledger: **Miningcore (HASH/PoW, both algorithms)** + **the PRANA TASK coordinator (AI work,
attested)**. They are independent share-sources into the same `UnifiedSharesLedger`.

---

## 4. PRIORITY vs FALLBACK — and the migration between them

This is the core sequencing decision. There are two ways to get verified shares onto the
on-chain ledger, and PRANA runs them as **priority** and **fallback**:

### PRIORITY — the in-chain decentralized pool (PR6)

The destination architecture is [`decentralized-pool.md`](./decentralized-pool.md): the
shares ledger is **native to PRANA** (`UnifiedSharesLedger`), there is exactly one canonical
pool pinned to the chain, and **many interchangeable coordinators** (anyone can run one,
bonded via `CoordinatorRegistry`, deduped via `JobClaimLedger`) post verified work to it. No
operator custodies funds; the chain pays directly. This is the P2Pool-grade, no-operator,
no-custody target. It is the priority because it is the most decentralized and the most
aligned with "the chain IS the pool."

### FALLBACK — Miningcore as a (more centralized) off-chain coordinator

A single forked Miningcore instance is **more operationally centralized** than a swarm of
permissionless coordinators: it is a conventional pool server that an operator runs, which
*posts verified work to the on-chain reward contract* via the settlement plugin above. It
still does **not custody** PRANA-native issuance (the chain pays on `claim()`), so it keeps
the most important safety property — but it is one operator's stratum, not a permissionless
mesh. It is the **fallback / bootstrap** engine: proven pool software that works on day one
while the permissionless-coordinator path and (especially) the TASK-lane verification harden.

### The migration: fallback → priority as verification matures

The two are not mutually exclusive — Miningcore is just **one coordinator** in the
`decentralized-pool.md` model, and it settles into the same ledger. So the path is additive,
not a rewrite:

1. **Bootstrap (fallback-dominant):** run the forked Miningcore as the primary HASH-lane
   coordinator (both Etchash + RandomX stratum). It posts `submitBatch` to the ledger. The
   permissionless `CoordinatorRegistry` exists but the operator set is thin.
2. **Open up:** as `CoordinatorRegistry` bonding + the cross-coordinator dedup
   (`JobClaimLedger`) are exercised in the wild, more independent coordinators (including
   other Miningcore forks, and the XX18-derived coordinators) join. The ledger is unchanged
   — miners just gain more interchangeable front-ends (the Hive/P2Pool "many front-ends, one
   chain" shape).
3. **Priority-dominant:** when the permissionless path is trusted (HASH self-verifies, so
   this is mostly an ops/anti-Sybil maturity question) and — critically — when **TASK-lane
   verification** is hardened ([`gridcoin-redirect.md`](./gridcoin-redirect.md) §verification),
   the decentralized in-chain pool is the main path and Miningcore is just one optional
   coordinator among many. No miner is ever locked to it: accrued shares are already on-chain.

The migration is gated by **verification maturity**, not by a flag day. The HASH lane is
self-verifying from the start (a PoW share is its own proof — `HashLaneCreditor`), so the
HASH side can decentralize quickly. The TASK/AI lane is the hard part and stays gated by the
K-of-N attestation quorum throughout; the fallback Miningcore engine deliberately doesn't
touch it.

---

## 5. Public-repo safety + honest status

- **Public-repo safe:** this note names only the public upstream
  ([oliverw/miningcore](https://github.com/oliverw/miningcore)) and the public PRANA
  contracts/skeletons. No server hostnames, operator endpoints, keys, or backend addresses
  appear here. The dev signer referenced by the skeleton is the publicly-known Anvil
  account #0 (DEV ONLY), already documented in `tools/pool-coordinator/src/config.mjs`.
- **Honest status:** the **fork itself is not yet done** — this is the build direction. What
  exists today is the coordinator skeleton (XX18) whose settle-tx shapes the Miningcore
  settlement plugin must emit, plus the on-chain contracts it settles into. The new code is
  small (the PRANA settlement plugin in §3); the rest is Miningcore's existing dual-stratum
  engine reused.

---

## See also

- [`decentralized-pool.md`](./decentralized-pool.md) (PR6) — the PRIORITY in-chain pool this
  is the fallback for; the custody-elimination + many-coordinators model.
- [`cpu-bootstrap.md`](./cpu-bootstrap.md) (AG13) — the RandomX CPU side this fork's second
  stratum serves; XMRig as the miner client.
- [`gridcoin-redirect.md`](./gridcoin-redirect.md) (AG14) — the TASK/AI lane Miningcore does
  NOT touch (it feeds HASH only); the GPUs-do-AI-instead-of-hashing mechanism.
- [`etchash-vs-ethash.md`](../chain/etchash-vs-ethash.md) (PR4/PR5) — the Etchash base the
  Ethash-family stratum verifies against; ECIP-1099 low-VRAM breadth.
- [`hardware-tiers.md`](./hardware-tiers.md) (PR13/PR14) — which hardware feeds HASH vs TASK.
- `tools/pool-coordinator/` (XX18 + PR8 + PR9) — the runnable coordinator skeleton whose
  settle shapes the Miningcore plugin reuses.
- BI25 / `G25-open-ethereum-pool.md` (vault) — the superseded single-algo reference.
