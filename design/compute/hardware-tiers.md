# Hardware Tiers — the honest map (who can mine, on what, into which lane)

**Backlog items:** PR14 (hardware-tier honest map) + PR13 (FPGA / open-silicon education
track) — `QUEUE-from-docs-8.md` §C.
**Source doc:** "PRANA — The Pool, Hardware Roles & The River" §1.
**Status:** onboarding / honest-scoping note.

> Dollar figures are marked *(as of the doc / approximate)* — they reflect the source
> document's ballpark and consumer GPU pricing at the time of writing, not a guarantee.
> Prices move; treat them as order-of-magnitude.

---

## 1. The honesty rule

The point of this doc (§1) is to be **honest about hardware** instead of overpromising.
Different people show up with wildly different machines, and PRANA's pool is designed so
*many* of them can contribute *something* — but we do not pretend a laptop competes with a
data-center, and we do not pretend a community education project can out-fabricate NVIDIA.
The map below says exactly what each tier can and cannot do.

---

## 2. The four hardware tiers

### Tier 1 — Buyable consumer GPU (the community substrate)

- **What:** gaming / workstation GPUs you can actually buy — roughly **$800–$4,000**
  *(as of the doc / approximate)* per card.
- **Role:** this is the **community substrate** — the broad base of ordinary contributors.
  It is the tier the whole pool is *for*. A consumer GPU can do real AI inference (TASK
  lane) and real microhashing (HASH lane).
- **Low-VRAM inclusion via Etchash:** a deliberate choice keeps *old* cards in the game.
  Using **Etchash (ECIP-1099 "Thanos")** — Ethereum Classic Core-Geth's modified
  Dagger-Hashimoto with a reduced / slower-growing DAG — even **low-VRAM 3–6 GB cards** can
  mine the microhash heartbeat day one, instead of being locked out by Ethash's
  ever-growing DAG. (The Etchash-vs-Ethash chain-config decision is its own note — see
  PR4/PR5, `QUEUE-from-docs-8.md` §B, and user decision UD-PR-B. Microhash is only one of
  two share streams, so this lever is low-stakes for the economy as a whole.)

### Tier 2 — Enterprise / data-center GPU

- **What:** data-center accelerators (the H100/A100-class and successors) — buyable, but at
  enterprise prices and availability, well above the consumer tier.
- **Role:** much higher AI-inference throughput; pours into the **TASK** lane at scale.
  Legitimate and welcome, but it is *not* the substrate the project is built around — the
  design intentionally keeps the consumer tier viable so the pool doesn't collapse into a
  data-center-only game.

### Tier 3 — AI-ASIC (cloud-rental-only)

- **What:** dedicated AI inference/training ASICs (the Groq/Cerebras/TPU-class of
  purpose-built silicon).
- **Role:** **cloud-rental-only** for almost everyone — you rent time on them, you don't
  buy the chip. They can do enormous AI work, but they are not something a community member
  owns. Treated as a rentable TASK-lane resource, not a substrate.

### Tier 4 — The "teach to make them" track (honestly scoped)

The doc explicitly scopes this as **VKFRI education, NOT foundry competition.** Two
sub-tracks:

- **FPGA AI-accelerator (real, ports into the pool).** An FPGA can be programmed as an AI
  inference accelerator that does *real* inference work, exposed through a worker adapter
  so it **ports into the pool and earns shares** on the TASK lane like any other worker.
  This is a genuine capability track, not a metaphor — an FPGA worker is a first-class TASK
  contributor.
- **Open-silicon literacy.** Teaching how chips are designed using open tooling —
  **Tiny Tapeout** and open PDK flows (e.g. the SkyWater open PDK) — so community members
  gain real silicon-design literacy.

**The hard honesty line:** this track is about *capability and education*, not beating the
fabs. **Leading-edge wafers (3 nm-class) cost millions of dollars per mask set and require
fabs that cost billions** — we **never** promise to out-fab NVIDIA, TSMC, or anyone else.
The deliverable is *people who understand and can build accelerators*, plus FPGA hardware
that actually earns in the pool — not a competing foundry. Promising otherwise would be
exactly the kind of overclaim this doc exists to prevent.

---

## 3. Hardware → lane mapping

The pool has three lanes in the
[`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol)
(`enum Lane { HASH, TASK, BURN }`). Hardware maps to the two *work* lanes (HASH, TASK)
as follows — BURN is a capital/perma-stake lane, not a hardware lane:

| Hardware                     | HASH (microhash)         | TASK (AI / useful work)        |
|------------------------------|--------------------------|--------------------------------|
| **Ethash-ASIC**              | hash-only, **capped**    | no                             |
| **Consumer GPU** (Tier 1)    | yes                      | yes — **both lanes**           |
| **Enterprise GPU** (Tier 2)  | yes                      | yes (high throughput)          |
| **CPU**                      | weak                     | **task-small** (small tasks)   |
| **FPGA** (Tier 4)            | n/a                      | **task** (real inference)      |

Reading the mapping:

- **ASIC = hash-only, capped.** A purpose-built Ethash ASIC can hash but can't do AI
  tasking, and its weight in the pool is deliberately **capped** so single-purpose hashing
  iron can't dominate the share pool (and so the microhash heartbeat stays a *security
  signal*, not the main economic point). ASIC-dampening levers (ProgPoW) are a separate
  option — PR5.
- **GPU = both.** A GPU is the versatile worker: it can mine the HASH heartbeat *and* run
  AI inference on the TASK lane. This is why the consumer GPU is the substrate — it spans
  the whole useful surface.
- **CPU = task-small.** A CPU is a poor hasher but can still pick up *small* AI/useful-work
  tasks, so even a plain machine contributes something on the TASK lane.
- **FPGA = task.** Programmed as an inference accelerator, an FPGA contributes to the TASK
  lane (Tier 4 capability track).

The auto-switching worker daemon (backlog XX17) is what reads a machine's capabilities and
routes it to the lane(s) it's good at; vardiff (PR9) smooths the share stream so a 3 GB GPU
and a big farm both submit steadily and are paid proportionally.

---

## 4. Onboarding takeaway

- Almost any modern machine can earn *something*: low-VRAM and old GPUs via Etchash on HASH,
  CPUs via small TASK work, consumer GPUs across both lanes.
- The pool is built around the **buyable consumer GPU**, not data-center hardware — that's a
  deliberate design choice to keep it a community substrate.
- The "make your own hardware" track is **real education + real FPGA earning**, honestly
  capped at *capability*, never at *out-fabbing the chip giants*.

---

## See also

- [`decentralized-pool.md`](./decentralized-pool.md) (PR6) — the pool the hardware feeds.
- PR4/PR5 Etchash/ECIP-1099 + ProgPoW chain-config note (`QUEUE-from-docs-8.md` §B);
  user decision UD-PR-B (microhash algorithm).
- Worker daemon XX17, vardiff PR9, multi-coin PR8 — the runnable client side.
