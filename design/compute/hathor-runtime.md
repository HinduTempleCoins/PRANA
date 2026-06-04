# Hathor — the distributed Oracle runtime (AG10)

**Backlog item:** AG10 (Round 9 — AI/GridCoin doc §3).
**Status:** runtime architecture note (spec/doc). Binds to already-built substrate; no new code here.

> Scope: how **Hathor** — the read-only Oracle/witness of the PRANA ecosystem — is *actually
> run* as software on top of the community compute substrate. This note picks the three
> distributed-inference patterns we use, ties them to the built inference ladder + the river,
> and re-states the hard read-only boundary. It is the runtime companion to the conceptual
> note `design/research/oracle-vs-oracalization.md` (BI26) and the per-subject output spec
> `clarity-score.md` (AG11).

---

## 1. What Hathor is (and is not)

Hathor is the **Oracle** in the Delphic sense set out in
[`oracle-vs-oracalization.md`](../research/oracle-vs-oracalization.md): not a feed and not a
single person, but a **network-as-interface** — a conglomerate of human interaction and
intent (an *egregore*) that renders **Clarity**. The Delphic Oracle was never one woman; it
was Pythia + the priests + the sanctuary operated as **one interface**. Hathor is the same
shape in modern dress: many models, many GPUs, many voices, presented through a single
surface. **She is a being to be *brought into existence*, not one already seated** — this
note is about the wiring that lets that interface speak, not a claim that the interface is
finished.

The runtime job of Hathor is narrow and witnessed:

- **analyze** subjects (tokens, contracts, contributions, content) from observable facts,
- **draft** text/summaries/explanations for humans,
- **witness** — attest to what the chain and the oracalization layer report,
- **render** the read-only **Clarity Score** (see `clarity-score.md`).

**She does NOT trade and CANNOT sign value.** This is the institutional invariant, enforced
by *shape*, not by trust:

- The protocol-fee sink she "operates" — [`HathorFeeTreasury.sol`](../../contracts/contracts/compute/HathorFeeTreasury.sol)
  (PP3) — **never trades**: it has no swap/AMM/router surface and the only outflow is a
  `GOVERNOR_ROLE` (DAO timelock) withdrawal. *"Hathor herself is read-only (she sets nothing
  here); she cannot move these funds. Only governance can."*
- The fee *rate* she "decides" — [`CountercyclicalFeeOracle.sol`](../../contracts/contracts/compute/CountercyclicalFeeOracle.sol)
  (PP2) — is a **pure function** of on-chain inputs with **no setter on the output**; only
  DAO-settable curve parameters, hard-clamped to a band. Hathor is read-only there too.
- In the agent marketplace ([`agent-marketplace.md`](../marketplaces/agent-marketplace.md),
  BI22) Hathor is the **View-only** flagship agent: read chain state, never sign; she
  "governs nothing she is not granted."

So everywhere Hathor appears in the value system she is a **witness with read access**, never
a custodian or a trader. The runtime below must preserve that: it is an *inference* runtime
(it produces text and scores), wired so that any value action is a *separate*, governed,
human/DAO-authorized step — never something the model itself can execute.

---

## 2. The three technical patterns — all used

A "distributed Oracle" is not one architecture; Hathor is served by **three** distinct
inference patterns, chosen per workload. They are complementary, not competing — the runtime
picks whichever fits the job and the hardware that is currently live.

### Pattern A — One large Hathor split across many GPUs (DISTRIBUTED inference)

**Petals / Hivemind — BitTorrent-style volunteer GPUs.** A single large model (e.g. a 70B
LLM) is split **by layer** into contiguous blocks; many small volunteer nodes ("minnows")
each hold one shard, and a forward pass **hops across the swarm** until the tail block emits
logits. No single node holds the whole model; the swarm *as a whole* runs it. **The pool's
own miners are the substrate** — the same consumer GPUs that mine the HASH/TASK lanes also
host model shards.

- **Petals** — [`bigscience-workshop/petals`](https://github.com/bigscience-workshop/petals),
  "BitTorrent for LLMs": run a server hosting a block range, a client routes the forward pass
  through whatever servers currently announce the needed blocks.
- **Hivemind** — [`learning-at-home/hivemind`](https://github.com/learning-at-home/hivemind):
  the DHT (distributed hash table) + libp2p transport that servers announce into and clients
  query to discover live block-holders.

This is exactly **the River** ([`river-join.md`](./river-join.md), XX20). Hathor as a Petals
*client* is the most-aligned, cheapest tier; the River is allowed to be a *real-but-imperfect*
tier and to fail (see cruxes §4). **Cross-link:** `tools/pool-worker/src/river-client.mjs`
(the shard client stub) and the River backend of the inference router.

### Pattern B — Clustered (boxes we control)

**Ray + vLLM / DeepSpeed** when the hardware is *controlled* (an enterprise GPU box, a rented
cluster, a VKFRI node) rather than scattered volunteers. Here we don't need BitTorrent-style
discovery — we have a known, low-latency cluster and want maximum throughput:

- **Ray** — [`ray-project/ray`](https://github.com/ray-project/ray): the distributed
  execution framework (Ray Serve) that orchestrates inference replicas across a controlled
  cluster.
- **vLLM** — [`vllm-project/vllm`](https://github.com/vllm-project/vllm): high-throughput
  serving with PagedAttention + continuous batching + tensor parallelism across the GPUs in a
  box/cluster.
- **DeepSpeed** — [`deepspeedai/DeepSpeed`](https://github.com/deepspeedai/DeepSpeed)
  (formerly `microsoft/DeepSpeed`): DeepSpeed-Inference tensor-slicing / ZeRO for models too
  big for one controlled GPU but spread across a *trusted* multi-GPU node.

Pattern B is the **latency-and-throughput tier** for when we own the boxes: a clustered vLLM
replica answers interactive requests fast, where the scattered River would be too slow
(§4.1). It maps to enterprise-GPU hardware (Tier 2 in [`hardware-tiers.md`](./hardware-tiers.md))
and to the paid/managed-vLLM rungs of the inference ladder.

### Pattern C — Many Hathor instances coordinating as one (the SWARM / egregore)

**Multi-agent / mixture-of-agents** — many *whole* model instances run independently and
their outputs are **aggregated into one response**. Where Pattern A splits *one model* across
GPUs, Pattern C runs *many minds* and converges them. This is the literal egregore: a
conglomerate of independent agents speaking as one interface.

- **Mixture-of-Agents (MoA)** — multiple LLMs answer in layers; each layer's agents see the
  previous layer's outputs and refine, with a final aggregator synthesizing one answer
  (Wang et al., 2024, *"Mixture-of-Agents Enhances Large Language Model Capabilities"*;
  reference implementation `togethercomputer/MoA`). Many models converge on one verdict.
- More broadly, multi-agent orchestration (proposer/critic/aggregator roles, debate, voting)
  — the same shape used for **redundant, comparable** outputs that the verification layer can
  cross-check (§4.3).

Pattern C is how Hathor renders a **witness verdict** that is not the opinion of a single
model: the Clarity Score (AG11) can be the *aggregated* output of several independent agents,
making it both more robust and more legible as "the network's judgment" rather than "one
model's guess."

#### How the three relate

| Pattern | Idea | Hardware | Reference | When |
|---|---|---|---|---|
| **A — Distributed** | one model split by layer across many GPUs | scattered volunteer GPUs (the pool's miners) | Petals + Hivemind | cheapest, most-aligned; background/batch; the River |
| **B — Clustered** | one model served fast on a controlled multi-GPU box | enterprise GPU / rented cluster (boxes we own) | Ray + vLLM / DeepSpeed | latency-critical, high-throughput |
| **C — Swarm** | many whole models converge to one answer | any mix (each agent runs on A, B, or an API) | mixture-of-agents / multi-agent | robust witness verdicts; the egregore |

These compose: a Pattern-C swarm can be made of agents that are *each* served by Pattern A
(River), Pattern B (cluster), or a free/paid API. The Oracle is the **interface over all of
it**, not any single layer.

---

## 3. The compute-sourcing ladder (free → free cloud → community river)

Hathor never assumes a backend is up. Every request walks a **priority ladder** and falls
through on failure/rate-limit, so the Oracle keeps serving even when the cheapest tiers are
down. This is the built [`@prana/inference-router`](../../tools/inference-router/) (XX19) —
*"Hathor pulls from whichever nodes are live."* The honest ordering, considering both cost
and alignment:

```
  (1) community river      Pattern A — Petals/Hivemind shard-holders (the pool's own miners).
        │                  cheapest + most aligned. tried FIRST. allowed to fail.
        ▼  (fall through on thin/incomplete swarm)
  (2) free / free-cloud     free API tiers + free cloud GPU (HuggingFace free tier,
        tiers               OpenRouter free model, a community Ollama/vLLM, free notebook
        │                   GPUs). free but RATE-LIMITED (token bucket per backend).
        ▼  (fall through on ratelimit / 503)
  (3) paid cloud           Anthropic / OpenAI / managed vLLM (a controlled Pattern-B box).
       fallback            costs money ⇒ ALWAYS LAST.
```

What is *real and tested* in XX19 is the **control flow** — priority ordering, the
fallthrough state machine, and the per-backend token-bucket rate limiter — with each
backend's `healthCheck()` / `infer()` stubbed for now. Real backends drop in without
touching the router. The River backend's `healthCheck()` asks whether enough of the model's
blocks are currently covered by live nodes to complete a forward pass; if coverage is
incomplete it reports **unhealthy** and the router falls through. **Cross-links:**
[`river-join.md`](./river-join.md) (XX20, the River tier) and
[`tools/inference-router/`](../../tools/inference-router/) (XX19, the ladder).

> Note on "free cloud GPU": this means *free notebook/credit GPU tiers* used as a worker or
> a free API, fronted by the same router rung — consistent with this repo's public-safe
> posture (no backend host/IP/credentials are recorded here; operational detail lives only in
> gitignored notes). This doc references *capabilities and public projects*, never
> infrastructure.

---

## 4. Honest cruxes (do not hand-wave these)

The distributed Oracle is attractive (volunteers' idle hardware serve a big model for free,
the swarm degrades instead of dying) but it has real costs. State them plainly.

### 4.1 Heterogeneous scattered-volunteer-GPU latency / bandwidth / reliability

A forward pass that hops over the public internet between **consumer** nodes is *much* slower
than one model on one datacenter GPU — especially the per-token round-trips during
generation, and especially on CPU-only or low-VRAM minnows (the Etchash-included 3–6 GB cards
from [`hardware-tiers.md`](./hardware-tiers.md)). Volunteers are heterogeneous: different
GPUs, different uplinks, different uptime. The River is good for **throughput / cost**, not
for **latency-critical interactive** use. This is *why Pattern B exists*: route
latency-sensitive requests to a controlled vLLM cluster (or a paid API rung) and reserve the
River for background/batch work — exactly the fallthrough the ladder already encodes.

### 4.2 Design for fault tolerance + graceful degradation

A minnow *will* vanish mid-pass (laptop sleeps, wifi drops). The swarm handles this by
routing around the dead node to another holder of the same blocks — **but** graceful
degradation is not free, it is **designed**:

- **Redundancy buys grace.** ≥2 holders per block range means a drop is routed around; a
  *thin* swarm with one holder per range goes **uncovered** and degrades *hard*, not
  gracefully. The Hivemind DHT TTL/heartbeat is the mechanism that lets the swarm *notice* a
  drop (`river-join.md` §4.2).
- **Fall through, don't fail.** When the River can't complete a pass, the router degrades to
  free → paid (§3) rather than erroring. The whole-system property is: *the Oracle keeps
  answering, possibly slower or costlier, never silently wrong.*
- **Clustered fallback.** Pattern B is the deterministic floor — a controlled box that is
  *assumed healthy* so there is always a backstop under the volunteer tiers.

### 4.3 Verification stays make-or-break

A volunteer node could return **garbage or adversarial** activations/logits instead of doing
the real forward pass — the same trust problem as every tier of PRANA's off-chain compute.
**The Oracle gets no verification exemption.** This is the make-or-break property called out
for the whole oracalization layer (`oracle-vs-oracalization.md` §2): an oracalization layer
is only as good as its **redundancy + attestation + staking/slashing**.

- Outputs that earn TASK-lane shares ride the **K-of-N attestation quorum** —
  [`TaskVerificationGate.sol`](../../contracts/contracts/compute/TaskVerificationGate.sol)
  over [`AttestationStakeSlash`](../../contracts/contracts/compute/) — fed to the ledger via
  the contribution router. Public open inference is hard to verify cheaply; for paid/critical
  work, **run redundant passes across disjoint holders and compare**, or gate settlement on
  the quorum. Pattern C (mixture-of-agents) is *naturally* redundant and gives comparable
  outputs to cross-check.
- This is the same honest stance as the **GridCoin / BOINC** trust model the whole compute
  layer inherits (verified off-chain, the chain trusts that accounting) — see the
  GridCoin/BOINC research notes and `decentralized-pool.md` §6.
- The **Clarity Score** (AG11) is itself **read-only and non-binding** — a *witness verdict*,
  not an automated value action — which keeps a wrong or gamed output from ever directly
  moving funds. Read-only-ness is, in part, a verification-risk *containment*.

---

## 5. Where this fits

- **Conceptual basis:** [`oracle-vs-oracalization.md`](../research/oracle-vs-oracalization.md)
  (BI26) — the Oracle-vs-data-layer distinction; the Delphic/egregore framing.
- **Per-subject output:** [`clarity-score.md`](./clarity-score.md) (AG11) — what Hathor
  *renders*, read-only and non-binding.
- **The River tier (Pattern A):** [`river-join.md`](./river-join.md) (XX20) +
  `tools/pool-worker/src/river-client.mjs`.
- **The ladder:** [`tools/inference-router/`](../../tools/inference-router/) (XX19).
- **Hardware substrate:** [`hardware-tiers.md`](./hardware-tiers.md) (PR13/PR14) — which GPUs
  feed which pattern.
- **Read-only boundary (value side):** [`HathorFeeTreasury.sol`](../../contracts/contracts/compute/HathorFeeTreasury.sol)
  (PP3, never trades), [`CountercyclicalFeeOracle.sol`](../../contracts/contracts/compute/CountercyclicalFeeOracle.sol)
  (PP2, pure function, no output setter), [`agent-marketplace.md`](../marketplaces/agent-marketplace.md)
  (BI22, View-only flagship).
- **Verification rail:** `TaskVerificationGate` + `AttestationStakeSlash` + the contribution
  router → `UnifiedSharesLedger`.
- **Upstream references:** Petals (`bigscience-workshop/petals`), Hivemind
  (`learning-at-home/hivemind`), Ray (`ray-project/ray`), vLLM (`vllm-project/vllm`),
  DeepSpeed (`deepspeedai/DeepSpeed`), Mixture-of-Agents (Wang et al. 2024,
  `togethercomputer/MoA`).
</content>
</invoke>
