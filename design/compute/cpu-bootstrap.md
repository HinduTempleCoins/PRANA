# CPU bootstrap — ordinary laptops mine from day one (RandomX), GPUs graduate to AI

**Backlog item:** AG13 (Round 9 — the AI / GridCoin doc, §11).
**Status:** architecture / onboarding note. Binds to the built worker/coordinator skeletons
and the on-chain lanes; no new code here.

> The breadth principle: at launch the people who show up have **laptops**, not GPU farms.
> If only GPUs can mine, the coin starts concentrated. RandomX light-mode lets a plain CPU
> secure and distribute the coin on day one; when a GPU *does* arrive, it is worth more on
> **AI work (Hathor)** than on hashing — so it graduates to the TASK lane.

---

## 1. The problem CPU-bootstrap solves

A fresh PoW chain has a chicken-and-egg distribution problem. The Etchash microhash lane
([`etchash-vs-ethash.md`](../chain/etchash-vs-ethash.md)) is **GPU-oriented** — even with
ECIP-1099's low-VRAM breadth, a competitive Etchash share stream wants a GPU. The TASK/AI
lane ([`gridcoin-redirect.md`](./gridcoin-redirect.md)) also wants a GPU (real inference).

So on day one, a chain with *only* those two lanes effectively says: **"no GPU, no coin."**
That hands early distribution to whoever already owns mining hardware — the opposite of
"regular people secure and distribute the coin." The hardware-tier map
([`hardware-tiers.md`](./hardware-tiers.md)) is honest that a CPU is a *weak hasher* and only
a *task-small* AI contributor — neither lane really welcomes a bare laptop.

**CPU-bootstrap closes that gap with a third, CPU-native PoW stream: RandomX.**

---

## 2. RandomX light-mode — why a plain CPU can mine

**[RandomX](https://github.com/tevador/RandomX)** is Monero's PoW algorithm: a
**CPU-friendly, ASIC-resistant** proof-of-work built around a random virtual machine that
executes random programs and is tuned to run best on a general-purpose CPU (it leans on the
exact features CPUs have — large caches, out-of-order execution, hardware AES). This is the
inverse of Etchash's GPU/memory-bandwidth bias: RandomX deliberately makes a commodity CPU
**the** competitive miner, and makes GPUs and ASICs *worse* at it.

RandomX has two operating modes, and the distinction is the whole point of "from day one":

- **Fast mode** — allocates a large (~2+ GB) dataset for maximum hashrate. For dedicated
  miners.
- **Light mode** — allocates only a small (~256 MB) cache and recomputes dataset items on
  the fly. Much lower memory, lower hashrate, **but it runs on essentially any machine**,
  including modest laptops. Light mode is what lets "ordinary CPUs mine from day one" with no
  special hardware and no multi-GB memory commitment.

So a regular person on a laptop runs RandomX in light mode, submits CPU shares, and is
**securing and distributing the coin** on equipment they already own — exactly the GridCoin
"anyone can participate on the hardware they have" ethos.

> Algorithm-choice note (user-gated, like UD-PR-B for Etchash): adding a *second* PoW
> algorithm to the chain is a real consensus/pool decision, not a flag. The lighter-weight
> alternative — keep block consensus on Etchash and run RandomX **only as a pool-side
> share stream** that credits the HASH lane — is discussed in §5. This note recommends but
> does not pin which.

---

## 3. The miner client — XMRig (one client, CPU and GPU, multiple algos)

The contributor's actual mining program is **[XMRig](https://github.com/xmrig/xmrig)** — the
standard open-source (GPLv3) miner. XMRig is the right pick because **one client covers the
whole hardware story** this design needs:

- **CPU + GPU backends** in one binary (it has CPU, OpenCL, and CUDA backends).
- **RandomX** (the CPU-bootstrap algorithm) **and KawPow / Ethash-family** algorithms — so
  the same miner a laptop user runs for RandomX is the same family of miner a GPU user can
  point at the Etchash microhash lane. (The built worker daemon already anticipates this: the
  `PRANA_HW_PROFILE` knob is `cpu | gpu | asic | fpga` and the lane preference is
  task-first/hash-fallback — `tools/pool-worker/README.md`.)

XMRig connects to a **stratum** endpoint. That endpoint is exactly the RandomX stratum the
**Miningcore fork** ([`miningcore-fork.md`](./miningcore-fork.md)) provides — the single pool
codebase that runs the RandomX (CPU) stratum *and* the Etchash (GPU) stratum in one process.
So the bootstrap path needs **no new pool stack**: XMRig (RandomX) → Miningcore's CryptoNote/
RandomX stratum → `HashLaneCreditor.submitBatch(...)` → `UnifiedSharesLedger` HASH lane,
keyed to the miner's beacon-bound payout `account` (`WorkerBeaconRegistry`, XX3).

CPU RandomX shares credit the **same HASH lane** as Etchash microhash shares — both are
self-verifying PoW, both pool at equal weight into the one ledger. From the ledger's point of
view it is just "verified hash work"; the *algorithm* is a pool/stratum detail.

---

## 4. The bootstrap-on-CPU → graduate-to-GPU-AI path

This is the through-line that distinguishes PRANA from a plain CPU coin:

```
   DAY ONE                         WHEN A GPU APPEARS
   ───────                         ──────────────────
   laptop CPU                      GPU
      │                              │
   RandomX light-mode            NOT pointed at more hashing
   (XMRig → RandomX stratum)         │
      │                           pointed at AI WORK (Hathor) — the TASK lane
   HASH lane (self-verifying)        │
      │                           run model shards / inference → K-of-N attested
   UnifiedSharesLedger            TaskVerificationGate → TaskLaneCreditor
      │                              │
   secures + distributes coin     UnifiedSharesLedger (same pool, equal weight)
```

The reasoning, grounded in the built pieces:

1. **Bootstrap on CPU.** Regular people run XMRig/RandomX light-mode and earn HASH-lane
   shares. The coin starts **distributed across many ordinary machines**, and the microhash
   heartbeat secures/orders blocks. No GPU required to participate.

2. **A GPU is worth more on AI than on hashing.** When a contributor brings a GPU online, the
   switching worker daemon (`tools/pool-worker`, XX17) detects the capability and — because
   its default lane preference is **task-first** — points it at the **TASK lane (AI work,
   running Hathor)**, *not* at more hashing. This is the literal GridCoin-redirect:
   **GPUs do useful AI work instead of burning cycles on hashes**
   ([`gridcoin-redirect.md`](./gridcoin-redirect.md)). The hardware-tier map already encodes
   this — "GPU = both lanes," and the substrate is meant to flow toward TASK.

3. **Same pool, indifferent worker.** Both lanes credit the **same** `UnifiedSharesLedger` at
   **equal weight** (`HashTaskWeightConfig` HASH=TASK by default), so a contributor who
   graduates from CPU-RandomX-hashing to GPU-AI-tasking keeps earning into the same pool —
   the switch is seamless and the worker is *indifferent* to which lane it is in. That
   indifference is what makes "graduate from hashing to AI" a smooth path rather than a
   migration.

So CPU-bootstrap and the GridCoin-redirect are two ends of one ramp: **CPUs get people in and
distribute the coin; GPUs, once present, are steered to the useful-work lane where they're
most valuable.** Hashing (CPU *or* GPU) is the **floor** that secures the chain; AI is the
**ceiling** the capable hardware climbs to.

---

## 5. Honest cruxes (don't hand-wave)

1. **Second-PoW-algorithm is a real decision, not a flag.** Making RandomX a *block-consensus*
   algorithm alongside Etchash is a consensus change (dual-algo PoW, difficulty splitting,
   client support) — heavier than the one-key Etchash toggle. The lighter, recommended
   bootstrap form is **RandomX as a pool-side share stream only**: it credits the HASH lane
   in `UnifiedSharesLedger` (an *accounting/reward* layer), while Etchash remains the chain's
   block-securing PoW. That gives "CPUs mine from day one" without a consensus fork. Either
   way it's user-gated — present, don't pin.
2. **CPU light-mode is low-hashrate.** Light mode trades hashrate for accessibility; a laptop
   will not out-earn a dedicated rig. That's fine and intended — the point is *broad
   distribution and participation*, not making laptops competitive with farms (same honesty
   line as [`hardware-tiers.md`](./hardware-tiers.md)). Vardiff (PR9, `pool-worker/src/vardiff.mjs`)
   smooths the share stream so a weak CPU still submits steadily and is paid proportionally.
3. **ToS / free-tier caveat.** Some environments (Colab/Kaggle and other free compute) forbid
   crypto *mining*. The worker daemon already has a `PRANA_FREE_TIER` mode that is **TASK-only,
   never hashes** — so free-tier machines do AI work, not RandomX. CPU-bootstrap via RandomX
   is for the contributor's **own** hardware.
4. **RandomX shares still need real verification.** Like Etchash, a RandomX share *is its own
   proof* (re-checkable cheaply), so it inherits the HASH lane's self-verifying property — no
   attestation needed. The pool just re-validates the PoW (the Miningcore RandomX stratum
   does this; the XX18 skeleton's `share-validator.mjs` stubs it). Unlike the TASK lane, there
   is nothing to attest.

---

## See also

- [`miningcore-fork.md`](./miningcore-fork.md) (AG12) — the one pool codebase whose RandomX
  stratum serves this CPU lane (and whose Etchash stratum serves the GPU HASH lane).
- [`gridcoin-redirect.md`](./gridcoin-redirect.md) (AG14) — the GPU end of the ramp: GPUs do
  AI (Hathor) instead of hashing; the TASK lane mechanism + verification crux.
- [`etchash-vs-ethash.md`](../chain/etchash-vs-ethash.md) (PR4/PR5) — the GPU-oriented
  microhash lane RandomX complements; ECIP-1099 low-VRAM breadth.
- [`hardware-tiers.md`](./hardware-tiers.md) (PR13/PR14) — the honest CPU=weak-hash /
  task-small map this lane improves on by adding a CPU-native PoW.
- `tools/pool-worker/` (XX17 + PR9) — the worker daemon (`PRANA_HW_PROFILE`, task-first
  switcher, `PRANA_FREE_TIER`, vardiff) that routes CPU→hash / GPU→task.
- Upstream: [RandomX](https://github.com/tevador/RandomX), [XMRig](https://github.com/xmrig/xmrig).
