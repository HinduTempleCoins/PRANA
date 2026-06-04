# The "River" — minnow-swarm model-serving (TASK XX20)

> §5 of the Pool/River compute design. How many small nodes ("minnows") each
> holding one **shard** of a model collectively serve a model too big for any
> single box — the **Petals / Hivemind** pattern — and how Hathor/Qwen pulls
> inference from whichever shards are currently live.

This note is a design + integration reference for the **client stub** at
`tools/pool-worker/src/river-client.mjs`. It is honest about the cruxes; the
river is a *real-but-imperfect* tier of the inference ladder (see
`tools/inference-router/` TASK XX19), not a magic box.

---

## 1. The model: a river of minnows

A single large model (say a 70B-parameter LLM) does not fit on one volunteer's
consumer GPU/CPU. The river splits the model **by layer** into contiguous blocks
("shards"):

```
   model = [ block 0 .. block 7 ][ block 8 .. block 15 ][ block 16 .. block 23 ] ...
                   │                      │                       │
              minnow A               minnow B                minnow C
            (holds 0-7)            (holds 8-15)            (holds 16-23)
```

Inference is a **forward pass that hops across the swarm**: the client sends the
input embedding to a node holding block 0, that node runs its blocks and forwards
the resulting hidden state to a node holding the next block range, and so on
until the tail block produces the output logits. No single node ever holds the
whole model; the river *as a whole* runs it.

This is exactly the **Petals** design ("BitTorrent for LLMs"), which is built on
top of the **Hivemind** decentralized-training/DHT library.

### Real projects this wraps

- **Petals** — `bigscience-workshop/petals` (https://github.com/bigscience-workshop/petals).
  Run a server that hosts a block range:
  ```
  python -m petals.cli.run_server <model-id> --block_indices <start:end>
  ```
  and a client that runs distributed inference:
  ```python
  from petals import AutoDistributedModelForCausalLM
  model = AutoDistributedModelForCausalLM.from_pretrained(<model-id>)
  out = model.generate(input_ids, max_new_tokens=...)
  ```
  The client transparently routes the forward pass through whatever servers
  currently announce the needed blocks.
- **Hivemind** — `learning-at-home/hivemind` (https://github.com/learning-at-home/hivemind).
  Provides the **DHT** (distributed hash table) that servers announce into and
  clients query to discover live block-holders, plus the libp2p transport and the
  expert/averaging primitives Petals builds on.

Our `river-client.mjs` is a **Node ESM stub** that documents the shape of those
two APIs so the PRANA worker daemon (`tools/pool-worker`) can later wrap a real
Petals server process / its RPC, without us committing to the Python stack now.

---

## 2. How a worker JOINS the river

The PRANA `pool-worker` already knows how to do HASH work and TASK (AI) work. The
river is a *flavor* of TASK work where the node serves a model shard instead of a
whole job. Joining:

1. **Pick / be assigned a shard.** The coordinator (or the DHT's own load
   balancing, as Petals does automatically) tells the node which block range to
   host based on current swarm coverage — nodes gravitate to under-served blocks.
2. **Announce into the DHT.** The node stores `{ peerId, modelId, blocks, ttl }`
   into the Hivemind DHT keyed by the model id. This is what makes the node
   *discoverable* by clients. → stub: `joinRiver(coordinatorUrl, shardId)`.
3. **Heartbeat.** The DHT entry has a **TTL**; the node must periodically
   re-announce or the entry expires and the swarm forgets it. → stub:
   `heartbeat()` (interval timer, `unref()`'d so it never pins the process).
4. **Serve forward passes.** On request, the node receives hidden states for its
   block range, runs the forward pass, and forwards the result to the next
   block-holder (or returns logits if it owns the tail). → stub: `serveShard()`.
5. **Leave gracefully.** Stop heartbeating; the TTL lapses and clients route
   around it. → stub: `leave()`.

```
   joinRiver() ──announce──▶ [ Hivemind DHT ]
       │                          ▲   │
   heartbeat() ──re-announce──────┘   │ query: "who holds blocks 8-15 of <model>?"
       │                              ▼
   serveShard() ◀──forward pass── Hathor/Qwen client routes through live nodes
       │
   leave() ──TTL lapses──▶ swarm forgets the node
```

---

## 3. How Hathor / Qwen PULLS from the river

Hathor (and the Qwen model behind it) is just a **client** of the river — the
first rung of the inference ladder in `@prana/inference-router`:

1. The inference router (XX19) is asked to serve a prompt. Its top-priority
   backend is `kind: 'river'`.
2. The river backend's `healthCheck()` asks the coordinator/DHT whether enough of
   the model's blocks are currently covered by live nodes to complete a forward
   pass. If coverage is incomplete (a block range has no live holder), the river
   reports **unhealthy** and the router **falls through** to the free-API tier,
   then to paid cloud. This is the whole point of the ladder: *Hathor pulls from
   whichever nodes are live, and degrades to free/paid when the swarm can't.*
3. If healthy, `infer(prompt)` runs the distributed forward pass across the live
   shard-holders and returns the completion, tagged with `servedBy` = the river.

So the river is the **cheapest, most-aligned tier**, but it is explicitly allowed
to fail — the router treats a thin/incomplete swarm as just another fallthrough.

---

## 4. Honest cruxes (do not hand-wave these)

The river is attractive (volunteers' idle hardware serve a big model for free)
but it has real costs. State them plainly so nobody is surprised later:

1. **CPU / cross-node latency.** A forward pass that hops over the public internet
   between consumer nodes is *much* slower than one model on one datacenter GPU —
   especially the per-token round-trips during generation, and especially on
   CPU-only minnows. The river is good for **throughput / cost**, not for
   **latency-critical** interactive use. Practical mitigations (also from Petals):
   keep block-holders topologically close, batch, cache attention KV, and prefer
   the river for background/batch TASK work while latency-sensitive requests fall
   through to a faster tier.
2. **Node-drop graceful degradation.** A minnow *will* vanish mid-pass (laptop
   sleeps, wifi drops). The swarm handles this by routing around the dead node to
   another holder of the same blocks — **but** (a) if that block range had only
   one holder, the model is temporarily *uncovered* and the river goes unhealthy,
   and (b) an in-flight forward pass through the dropped node must be **retried**,
   spiking tail latency. Redundancy (≥2 holders per block range) is what buys
   graceful degradation; a thin swarm degrades hard, not gracefully. The heartbeat
   TTL is the mechanism that lets the swarm *notice* the drop.
3. **Verification still applies.** A volunteer node could return **garbage or
   adversarial** activations/logits instead of doing the real forward pass — the
   same trust problem as every other tier of PRANA's off-chain compute. The river
   does **not** get a verification exemption: outputs are subject to the same
   off-chain attestation / redundancy / K-of-N quorum the rest of the compute
   layer uses (cf. `TaskVerificationGate`, the AI-job attestation rail). Public
   open inference is hard to verify cheaply; for paid/critical TASK work, run
   redundant passes across disjoint holders and compare, or gate settlement on the
   attestation quorum. This is the same honest stance as the GridCoin/BOINC trust
   model the whole compute layer inherits.

---

## 5. Where this fits

- **Client stub:** `tools/pool-worker/src/river-client.mjs`
  (`joinRiver` / `heartbeat` / `serveShard` / `leave`) + `test/river-client.test.mjs`.
- **Consumed by:** `tools/inference-router/` (XX19) as the top-priority `river`
  backend in the fallthrough ladder.
- **Verification:** the existing compute attestation rails (`TaskVerificationGate`,
  AI-job attestation mapping) — the river is not exempt.
- **Upstream references:** Petals (`bigscience-workshop/petals`), Hivemind
  (`learning-at-home/hivemind`).
