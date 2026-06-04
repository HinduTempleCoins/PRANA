# The GridCoin redirect — "GPUs do AI instead of hashing IS the mining"

**Backlog item:** AG14 (Round 9 — the AI / GridCoin doc, §2).
**Status:** architecture note — the core mechanism. Binds to already-built contracts +
skeletons; no new code here.

> This is the thesis of the whole compute design. GridCoin pays volunteers for **useful**
> off-chain work (BOINC science) instead of useless hashing. PRANA does the same for **AI**:
> the pool registers available GPUs, assigns them AI jobs (run Hathor), and the AI work —
> not a hash — is what earns. Hashing stays only as a thin security/ordering floor.

---

## 1. The one-line idea

In GridCoin, the chain's blocks are secured cheaply and the **reward** flows to people whose
GPUs/CPUs did real **science** (BOINC), verified **off-chain** by project servers (the chain
trusts that accounting — the "Proof-of-Research" model, see the G6 research note).

PRANA keeps that shape but swaps the useful work:

> **A GPU doing AI work (running Hathor / inference) IS the mining.** The GPU is not pointed
> at hashes; it is pointed at AI jobs, and *that* is what earns shares in the pool. Hashing
> is reduced to a thin heartbeat that secures and orders blocks — not the economic point.

This is why the chain is **GridCoin-adjacent**: GridCoin uses PoS for blocks; PRANA keeps a
*lightweight* Etchash PoW for block security/ordering ([`etchash-vs-ethash.md`](../chain/etchash-vs-ethash.md))
while the **useful-work reward layer** is the GridCoin idea, implemented on-chain.

---

## 2. The mechanism, step by step (grounded in the built lanes)

The pool already has the two lanes this needs, baked into `UnifiedSharesLedger`
(`enum Lane { HASH, TASK, BURN }`, NN1). The redirect is the **TASK** lane doing the heavy
lifting and the **HASH** lane staying thin:

```
   1. REGISTER          a worker advertises its GPU to a coordinator
        │                (WorkerBeaconRegistry XX3 binds it to a payout account, anti-Sybil)
        ▼
   2. ASSIGN            coordinator hands out an AI job (run Hathor / inference)
        │                GET /job → JobClaimLedger (PR2) claims it once, cross-coordinator
        ▼
   3. WORK              GPU runs the AI job → produces a result (+ result ref)
        │
        ▼
   4. ATTEST            K-of-N staked attestors verify the result (off-chain compute,
        │                economically secured) → TaskVerificationGate (NN4)
        ▼
   5. CREDIT            TaskLaneCreditor.creditVerified(claimId, taskId, baseShares) (NN3)
        │                mints pooled shares into the TASK lane — equal weight to a hash share
        ▼
   6. PAY               UnifiedSharesLedger.claim(epoch) pays the worker pro-rata (PPLNS),
                         straight from the contract — no coordinator custody
```

Meanwhile, in parallel and *thin*:

```
   HASH lane (the security floor)
   Etchash microhash (GPU) + RandomX (CPU bootstrap) → self-verifying PoW shares
        → HashLaneCreditor.submitBatch(...) (NN2) → same UnifiedSharesLedger, equal weight
```

The two lanes pool into the **same** ledger at **equal weight** (`HashTaskWeightConfig`
HASH=TASK=1e18 by default, NN5). That equal-weighting is what makes the worker **indifferent**
to which lane it is in — and it is what lets the design *redirect* a GPU from hashing to AI
without the GPU losing anything: a TASK share is worth exactly a HASH share. (That equality
is precisely why TASK must be hard to forge — §4.)

### "Bootstrap on CPU, graduate to GPU-AI"

The switching worker daemon (`tools/pool-worker`, XX17) is **task-first**: when a GPU is
present, it claims AI jobs (the TASK lane) and only falls back to hashing if there's no AI
demand (the PR3 zero-AI-demand graceful-degradation path). CPUs hold the HASH floor via
RandomX ([`cpu-bootstrap.md`](./cpu-bootstrap.md)). So the steady state is:
**CPUs hash to secure; GPUs do AI to earn the bulk.**

---

## 3. The DevCoin "one pool in the code" reward routing

How does the *issuance* get split between "secure the chain" and "pay for useful AI work"?
The model is **DevCoin's "one pool in the code"** (the G7 DevCoin/bounty research note):
DevCoin routed a fixed slice of every block's coin to a single, code-defined pool that then
distributed to contributors — the *protocol*, not an operator, owns the routing.

PRANA does this with **one** on-chain pool and a thin-floor split:

- **There is exactly one pool** — `UnifiedSharesLedger` — pinned in the protocol. A fixed
  per-epoch PRANA issuance flows into it and is paid pro-rata over a rolling PPLNS window.
  There is no second pool to capture; "one pool in the code" is literal here
  ([`decentralized-pool.md`](./decentralized-pool.md) §1).
- **A thin slice secures blocks; the bulk goes to verified AI work.** Because HASH and TASK
  share the same pool, the *effective* split between "hashing reward" and "AI reward" is just
  the ratio of HASH shares to TASK shares times the governed lane weight (`HashTaskWeightConfig`,
  NN5). Setting the design so the microhash heartbeat is a **thin, capped** security signal
  (ASIC hash weight is deliberately capped — [`hardware-tiers.md`](./hardware-tiers.md)) while
  the bulk of shares come from the TASK lane means **most issuance routes to verified AI
  work**, with only a thin slice paying for block-securing hashes. The DAO tunes the lane
  weight; it does not run a second pool.

So: **a thin slice → block security (hash); the bulk → the verified-AI-work pool (task)** —
one pool, code-defined routing, governed ratio. No operator decides the split; the contract
+ the share mix do.

---

## 4. The verification crux (the hard part — stated honestly)

The redirect's entire safety rests on one question: **a TASK share is worth a real HASH
share, so what stops a worker from claiming AI credit for work it didn't do (or did wrong)?**
A HASH share is self-verifying (a PoW *is* its proof). **Useful AI work is not cheaply
self-verifiable** — this is the open research problem the whole field is wrestling with.

PRANA does **not** hand-wave this. The TASK lane is gated by **layered economic security**
(already built — see [`decentralized-pool.md`](./decentralized-pool.md) §6):

- **K-of-N attestation quorum.** `TaskVerificationGate` (NN4) only marks a claim verified
  once K-of-N distinct *staked-active* attestors attest it; `TaskLaneCreditor` won't mint
  until `isVerified() && consume()` (one-shot, so a verdict credits at most once).
- **Stake at risk + slash.** Attestors hold stake (`AttestationStakeSlash.isActive()`); a
  fraudulent attestor is slashable.
- **Bonded coordinator.** The coordinator itself must be registered, active, unslashed, and
  bonded (`CoordinatorRegistry`, PR1); proven fake-work → `slash()` → bond to treasury.
- **Cross-coordinator dedup.** `JobClaimLedger` (PR2) makes a unit of work claimable once
  chain-wide, so two coordinators can't double-credit the same job.
- **Redundancy where it matters.** For critical/paid work, run the job redundantly across
  disjoint workers and compare (the same stance the river/inference layer takes —
  [`river-join.md`](./river-join.md) §4).

This is **the same trust model GridCoin/BOINC use** (off-chain verification the chain trusts),
hardened with stake + slashing. It is honestly a **trust assumption**, not a trustless proof —
and the design says so.

### Precedents we are explicitly building on / toward

The redirect **hardens toward Proof-of-Useful-Work** as the verification field matures. The
real projects in this space, and what each contributes:

- **[Gensyn](https://www.gensyn.ai/)** — "proof-of-learning": probabilistic verification of
  ML *training* via replicated computation + graph-based proofs, so a verifier doesn't have
  to redo the whole job. The direction PRANA's TASK verification can adopt to reduce the
  cost of the K-of-N check (G17/O21 notes).
- **[Bittensor](https://bittensor.com/)** — Yuma consensus: peers *score* each other's model
  outputs and stake-weighted consensus on those scores sets rewards. PRANA's `TaskRegistry`
  (RR1, Bittensor-modeled) + attestation quorum echo this — useful work judged by a
  staked peer set, not a single oracle (O20 note).
- **[Prime Intellect](https://www.primeintellect.ai/)** — decentralized *training* across
  heterogeneous, distributed hardware (the river/Petals lineage in
  [`river-join.md`](./river-join.md)); shows the work-distribution side at scale (O23 note).
- **GPU marketplaces — [io.net](https://io.net/), [Render](https://rendernetwork.com/),
  [Akash](https://akash.network/)** — settlement layers that pay for *rented* compute. PRANA's
  difference: the chain is the accounting + reward layer and the compute is verified useful
  work that **earns native issuance**, not a rental invoice (O22 note).

The honest summary: **fully trustless proof of useful AI work is unsolved.** PRANA ships the
GridCoin/BOINC trust model with stake-slashing economic security now, and is built to adopt
Gensyn/Bittensor-style cheaper verification as it matures — *hardening toward* PoUW, not
claiming to have already achieved it.

---

## 5. Why this is the design (the payoff)

- **Useful, not wasteful.** GPUs run AI (Hathor / inference) — real output the ecosystem
  uses — instead of burning electricity on hashes whose only product is security. That is the
  GridCoin promise, applied to AI.
- **Hashing kept as a thin security floor.** Etchash (GPU) + RandomX (CPU) microhashing still
  secures/orders blocks, but capped and thin, so it's a *signal*, not the economy. Resolves
  the brief's tension ("GPUs doing useful work, not useless hashes") by keeping PoW minimal
  and putting the value on the TASK lane.
- **One pool, governed split.** DevCoin "one pool in the code": a thin slice secures, the
  bulk pays verified AI — all in the single `UnifiedSharesLedger`, ratio tuned by the DAO.
- **Custody-free + decentralizable.** The chain pays workers directly on `claim()`; many
  coordinators can run; accrued shares live on-chain (the P2Pool/Hive property of
  [`decentralized-pool.md`](./decentralized-pool.md)).

---

## 6. Public-repo safety + honest status

- **Public-repo safe:** names only public projects (GridCoin/BOINC, Gensyn, Bittensor, Prime
  Intellect, io.net/Render/Akash) and the public PRANA contracts/skeletons. No server,
  endpoint, key, or backend reference.
- **Honest status:** the **contracts + skeletons that implement this exist** (NN1-NN5, PR1-PR2,
  XX17-XX18). The **verification is the open frontier** — the K-of-N + stake-slash gate is
  built and is a real (trust-assuming) economic-security layer; cheaper/stronger
  Gensyn/Bittensor-style verification is the maturation path, not yet shipped. The "Hathor as
  the AI job" runtime is itself a separate spec (AG10/AG11, pending). Nothing here claims
  trustless PoUW.

---

## See also

- [`decentralized-pool.md`](./decentralized-pool.md) (PR6) — the one ledger this routes into;
  the §6 two-lane verification (HASH self-verifies, TASK rides attestation+stake+slash).
- [`cpu-bootstrap.md`](./cpu-bootstrap.md) (AG13) — the CPU/RandomX HASH floor; the
  bootstrap-on-CPU → graduate-to-GPU-AI ramp this is the GPU end of.
- [`miningcore-fork.md`](./miningcore-fork.md) (AG12) — the off-chain pool engine that feeds
  the HASH lane (both algorithms); it deliberately does NOT touch the TASK lane.
- [`river-join.md`](./river-join.md) (XX20) — minnow-swarm model serving (Petals/Hivemind);
  one flavor of TASK work, same verification stance.
- [`hardware-tiers.md`](./hardware-tiers.md) (PR13/PR14) — GPU=both lanes, ASIC hash-capped;
  why the substrate flows toward TASK.
- Contracts: `UnifiedSharesLedger` (NN1), `HashLaneCreditor` (NN2), `TaskLaneCreditor` (NN3),
  `TaskVerificationGate` (NN4), `HashTaskWeightConfig` (NN5), `CoordinatorRegistry` (PR1),
  `JobClaimLedger` (PR2), `WorkerBeaconRegistry` (XX3) — all under
  `contracts/contracts/compute/`.
- Vault research: G6 (GridCoin/BOINC), G7 (DevCoin), G17/O20-O23 (compute verification,
  Bittensor, Gensyn, io.net/Render/Akash, Prime Intellect).
