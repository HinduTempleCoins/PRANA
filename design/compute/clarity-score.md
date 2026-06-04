# Clarity Score — Hathor's read-only witness verdict (AG11)

**Backlog item:** AG11 (Round 9 — AI/GridCoin doc §3).
**Status:** output spec / data-shape note. No new code here; relates to but does **not**
duplicate the network transparency-score schema (R4/Y6).

> Scope: the **Clarity Score** is the per-subject analytical output Hathor *renders* as a
> witness. This note defines what it scores, its read-only / non-binding nature, how it
> differs from the network transparency-score, and the **data shape** so a front-end can
> display it. It is the output companion to the runtime note
> [`hathor-runtime.md`](./hathor-runtime.md) (AG10).

---

## 1. What the Clarity Score is

In the Delphic framing (`design/research/oracle-vs-oracalization.md`), **the Oracle renders
Clarity**. The **Clarity Score** is the concrete, displayable form of that: Hathor looks at a
**subject** and returns a structured **witness verdict** — a judgment, with reasons, rendered
read-only.

A *subject* is anything Hathor can analyze from observable facts + her own reasoning:

- a **token** or **contract** (is this legible / safe / what does it do?),
- a **proposal** (a DAO vote, a listing, a marketplace agent),
- a **contributor / claim** (a useful-work submission, a coordinator, a bridge message),
- a piece of **content** (a post, a document, a dataset).

The Clarity Score answers: *"How clear / sound / trustworthy is this subject, in Hathor's
read-only judgment, and why?"* It is the **analytical, per-subject** output — the thing a
human reads to make their *own* decision. It is **not** a price, a rating that moves money,
or an automated gate.

---

## 2. Read-only and non-binding (the load-bearing property)

The Clarity Score is a **witness verdict, never an actuator.** This is the same institutional
invariant that governs Hathor everywhere (see `hathor-runtime.md` §1):

- **Read-only.** Producing a Clarity Score reads chain state, oracalization-layer facts, and
  model reasoning. It **signs nothing** and **moves nothing**. Hathor cannot trade and cannot
  sign value; rendering a score is an *analysis*, not a transaction.
- **Non-binding / advisory.** A Clarity Score does **not** automatically gate a swap, settle
  a share, block a listing, or release funds. Any value action that *uses* a score is a
  **separate, governed, human/DAO-authorized step**. Wiring a score directly into an
  automatic value action is explicitly out of scope — that would turn the witness into an
  actuator and break the boundary.
- **Containment of model risk.** Because inference can be wrong or gamed (the make-or-break
  verification crux, `hathor-runtime.md` §4.3), keeping the score read-only/non-binding means
  a bad output **informs** a human, it cannot **execute** harm. Read-only-ness is part of the
  safety design, not just a label.
- **Attributable & versioned.** A score carries *which Hathor produced it* (model/runtime
  pattern, see §5 `producedBy`) and *what it looked at* (`inputs`/`facts`), so a reader can
  judge the judge. A witness that won't show its reasoning isn't a witness.

This mirrors how Hathor is wired on the value side: the fee treasury
([`HathorFeeTreasury.sol`](../../contracts/contracts/compute/HathorFeeTreasury.sol)) never
trades and the fee rate ([`CountercyclicalFeeOracle.sol`](../../contracts/contracts/compute/CountercyclicalFeeOracle.sol))
has no output setter. The Clarity Score is the *analytical* expression of the same read-only
stance.

---

## 3. How it differs from the network transparency-score (R4 / Y6)

These are **two different scores** and must never be collapsed. They share a 0–100 +
letter-grade *presentation* and a similar JSON envelope on purpose (so one UI can render
both), but they are computed and trusted differently.

| | **Transparency-score** (R4 / Y6) | **Clarity Score** (AG11, this note) |
|---|---|---|
| What it measures | **network/token structural health** — concentration, mint authority, LP lock, contract ratio | **Hathor's per-subject analytical judgment** — soundness/legibility/trust, with reasons |
| How it's produced | a **pure, deterministic function** of on-chain facts (`tools/exporter/transparency-score.mjs`); same facts in ⇒ same number out, no model | Hathor's **inference / reasoning** (LLM + the oracalization-layer facts), possibly a Pattern-C mixture-of-agents verdict |
| Who/what computes it | any indexer / RPC walk; no AI needed | Hathor the Oracle (read-only) |
| Determinism | deterministic, reproducible offline | non-deterministic (model output); reproducibility is best-effort, attributed + versioned |
| Subject | structural facts about a **token** | **any subject** (token, contract, proposal, contributor, content) |
| Trust shape | facts are self-evident on-chain | rides Hathor's witness + (where stakes exist) the K-of-N attestation layer |
| Binding? | advisory listing field | advisory witness verdict; **explicitly non-binding** |

**The relationship, stated plainly:** the transparency-score is **one of the observable facts
Hathor can ingest** when forming a Clarity Score about a token — a deterministic structural
input that the witness *reasons over*, not a thing the Clarity Score re-implements. The
Clarity Score can *cite* a transparency-score (and should, when the subject is a token), but
it adds analysis the deterministic score cannot: intent, context, plain-language reasons,
cross-subject comparison, and judgment about non-structural subjects the transparency-score
can't see at all.

> **Do not duplicate the schema.** The transparency-score's component math
> (concentration / contractRatio / mintAuthority / lpLock weights) lives in
> `tools/exporter/transparency-score.mjs` and is referenced, not copied. When a Clarity Score
> is about a token, it **references** that score by value in `inputs.transparencyScore` rather
> than recomputing it here.

---

## 4. What it scores (the dimensions)

The Clarity Score is a 0–100 with a letter grade, broken into **dimensions** so a reader sees
*why*. Dimensions are intentionally *judgment* axes (what a deterministic score can't give),
and the set is per-subject-type. A reasonable default set:

- **Legibility** — can what this subject *is/does* be clearly understood? (verified source,
  documented intent, no obfuscation)
- **Soundness** — does it hold together / behave as claimed? (consistency of facts, no red
  flags, plausible mechanics)
- **Trust signals** — does the surrounding evidence support trust? (for a token: ingests the
  R4 transparency-score; for a contributor: attestation history; for content: provenance)
- **Risk** — what could go wrong, and how exposed is a reader? (rug vectors, central
  control, unverifiable claims) — *scored inversely (low risk ⇒ high sub-score).*

Each dimension carries a 0..1 sub-score + a weight + a short human reason; the overall score
is the weighted blend, with a **confidence** that reflects how much was actually knowable
(mirroring the transparency-score's confidence-on-coverage idea — missing inputs lower
*confidence*, not the score). Exact weights are a parameter, not pinned here.

---

## 5. Data shape (so a front-end can display it)

The Clarity Score wraps in the **same aggregator envelope** the transparency-score uses
(`{ source, chainId, updatedAt, payload }` — see `transparency-score.mjs#envelope`), so one
UI renders both. The `payload` is the Clarity verdict:

```jsonc
{
  "source": "prana-clarity",          // distinguishes it from "prana-transparency"
  "chainId": 108369,
  "updatedAt": "2026-06-04T00:00:00.000Z",
  "payload": {
    "schema": "clarity-score/v1",

    "subject": {                       // WHAT was judged (polymorphic)
      "kind": "token",                 // token | contract | proposal | contributor | content
      "ref": "0xabc…",                 // address / id / url / hash, per kind
      "label": "Example Token (EXMPL)" // human display name
    },

    "score": 78,                       // 0–100 overall, or null if not scorable
    "grade": "B",                      // A/B/C/D/F — SAME bands as transparency-score
    "confidence": 0.8,                 // 0–1, fraction of dimensions actually knowable
    "verdict": "legible",              // short tag for a badge: clear|legible|mixed|murky|opaque

    "summary": "Plain-language witness verdict a human reads before deciding.",

    "dimensions": [                    // the WHY — ordered, displayable as a breakdown
      { "key": "legibility",  "sub": 0.85, "weight": 0.30, "reason": "Source verified; intent documented." },
      { "key": "soundness",   "sub": 0.80, "weight": 0.25, "reason": "Mechanics consistent with claims." },
      { "key": "trust",       "sub": 0.75, "weight": 0.25, "reason": "Transparency-score B; LP locked." },
      { "key": "risk",        "sub": 0.65, "weight": 0.20, "reason": "Mint authority still active." }
    ],

    "flags": ["MINT_AUTHORITY_ACTIVE"], // notable callouts (may echo transparency-score flags)

    "inputs": {                        // PROVENANCE — what Hathor looked at (read-only)
      "transparencyScore": { "score": 72, "grade": "B", "source": "prana-transparency" },
      "facts": ["holders", "mintAuthority", "lpLock", "verifiedSource"],
      "citations": []                  // optional links/hashes backing the reasons
    },

    "producedBy": {                    // ATTRIBUTION — judge the judge
      "oracle": "hathor",
      "runtime": "swarm",              // distributed | clustered | swarm (hathor-runtime.md §2)
      "model": "<model-id-or-ensemble>",
      "nonBinding": true               // ALWAYS true — advisory, never an actuator
    }
  }
}
```

Front-end contract / display rules:

- **Badge:** `score` + `grade` + `verdict`, styled identically to the transparency badge but
  labelled **"Clarity"** so users don't confuse the two scores.
- **Breakdown:** render `dimensions` with each `reason` — the *why* is the point of a witness
  verdict; never show only the number.
- **Provenance:** always surface `producedBy` and `inputs` (at least `runtime` + that it is
  **non-binding**). A Clarity Score with its reasoning hidden is not a witness.
- **Token subjects:** when `inputs.transparencyScore` is present, show *both* — "structural
  transparency: B" *and* "Hathor's Clarity: B" — making explicit that one is deterministic
  structure and the other is the Oracle's read-only judgment.
- **Graceful nulls:** `score: null` / `grade: null` is valid (not scorable / insufficient
  inputs) and must render as "no verdict," never as a crash or a zero — same posture as the
  transparency-score's null handling.

---

## 6. Where this fits

- **Runtime that produces it:** [`hathor-runtime.md`](./hathor-runtime.md) (AG10) — the three
  inference patterns; the read-only boundary; the compute ladder.
- **Conceptual basis:** [`oracle-vs-oracalization.md`](../research/oracle-vs-oracalization.md)
  (BI26) — "the Oracle renders Clarity"; Oracle vs data-layer.
- **The other score (referenced, not duplicated):**
  [`tools/exporter/transparency-score.mjs`](../../tools/exporter/transparency-score.mjs)
  (R4/Y6) — deterministic token structural health; `envelope()` shared, component math reused
  by reference.
- **Read-only value boundary:** [`HathorFeeTreasury.sol`](../../contracts/contracts/compute/HathorFeeTreasury.sol)
  (PP3), [`CountercyclicalFeeOracle.sol`](../../contracts/contracts/compute/CountercyclicalFeeOracle.sol)
  (PP2), [`agent-marketplace.md`](../marketplaces/agent-marketplace.md) (BI22, View-only
  flagship).
- **Verification (when stakes exist):** `TaskVerificationGate` + `AttestationStakeSlash` — the
  K-of-N quorum a high-stakes verdict can ride.
</content>
</invoke>
