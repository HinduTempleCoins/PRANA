# The Human-Training Layer — Platform Spec

**Backlog item:** AG6 (`tools/brain/state/QUEUE-from-docs-9.md` §A).
**Source doc:** "PRANA — AI & GridCoin Engine" §5, §6 (the human-contribution layer).
**Status:** architecture note (spec/doc). Binds to the human-contribution contracts
(AG1–AG5) and to the already-built compute stack; no new code in this file.

> Figures and ratios marked *(as of the doc / approximate)* are taken from the source
> document or cited precedents and are illustrative, not pinned parameters. The DAO sets
> the real values. Pay framing here is deliberately conservative — see §8.

---

## 1. The one-line idea — "one platform, two halves, two buyers"

PRANA's human-training layer is a single contribution platform that is **half
RemoTasks and half survey panel**:

1. **The RemoTasks half — humans train the AI.** People do the labor that makes models
   good: ranking model outputs (RLHF preference data), writing demonstration
   prompt/response pairs (SFT), evaluating and red-teaming model behavior, annotating
   data, and — at the top — supplying *expert* judgement (ethnobotany, law, theology,
   crypto, scholarship) that is the hardest data in the world to source. This is the
   Scale AI / Outlier / Surge business: a labor marketplace that produces training data.

2. **The survey / market-research half — humans sell their opinions.** The same people
   answer surveys and polls, sit in focus groups, and give product feedback. This is the
   Prolific / Respondent / Sapien business: a verified-human panel that sells opinion data
   to businesses and researchers.

**The convergence (the key insight, §6):** these two halves are *the same act*. Ranking
two model answers ("which response is better, and why?") is **RLHF preference data** to a
model builder and **a focus-group / product-feedback signal** to a market-research client.
So one contribution can be **sold to two buyers at once** — model builders (including
PRANA's own Hathor) *and* market-research clients — roughly **doubling revenue per
contribution**. The platform is designed around that double-sale from the start; it is the
economic reason this layer exists rather than being "just another Mechanical Turk."

Everything a contributor earns routes into the **same unified mining pool** that pays
hashers and AI-compute workers — human useful-work is just another lane of credit (§4).

---

## 2. Where this binds — the real contracts

This platform is the human-facing front of a contract pipeline that mirrors the
already-built AI-compute stack one-for-one. The compute stack is the proven pattern; the
human stack reuses it:

| Human layer (AG1–AG5) | Mirrors built compute contract | Role |
|---|---|---|
| `HumanTaskRegistry` (AG1) | [`TaskRegistry.sol`](../../contracts/contracts/compute/TaskRegistry.sol) | DAO-governed catalog of task-types |
| `HumanContributionGate` (AG2) | [`TaskVerificationGate.sol`](../../contracts/contracts/compute/TaskVerificationGate.sol) | verify-before-pay, one-shot `consume()` |
| `ReputationRegistry` (AG3) | (new — Sapien-style stake+rep) | per-contributor rep tier + slashable stake |
| `ProofOfHumanCredential` (AG4) | composes with `AttestationStakeSlash` security model | the verified-human gate (the moat) |
| `HumanTaskCreditor` (AG5) | [`TaskLaneCreditor.sol`](../../contracts/contracts/compute/TaskLaneCreditor.sol) | holds `TASK_CREDITOR`, credits the pool |

The pool itself is
[`UnifiedSharesLedger.sol`](../../contracts/contracts/compute/UnifiedSharesLedger.sol)
(NN1). **No new lane is added** — human contribution is credited through the existing
**TASK lane**, exactly as AI-compute work is. (Whether to instead add a 4th `HUMAN` lane
to the audited ledger enum is **UD-AG-A**, a user decision, and is *not* picked here; the
recommended path the queue records is "reuse TASK lane, no enum change.")

The crediting path is identical in shape to the AI path. In `TaskLaneCreditor`, the
sequence is: pull a one-shot verified verdict out of the gate (`gate.consume(claimId)` →
binds the worker), read the live governed weight from the registry
(`registry.shareWeight(taskId)`), then `ledger.creditShares(worker, Lane.TASK,
weightedShares)`. `HumanTaskCreditor` does the same, with `HumanContributionGate` standing
in for `TaskVerificationGate` and `HumanTaskRegistry` for `TaskRegistry`. The pool can't
tell — and doesn't need to know — whether a TASK-lane share came from a GPU running
inference or a person ranking two answers. **The chain is the accounting + reward layer;
the human work is a labor-marketplace, the same way GPU compute is a work-marketplace.**

---

## 3. The task-type taxonomy

Every task-type is a row in `HumanTaskRegistry` (AG1), the human analog of `TaskRegistry`.
Each entry carries (mirroring the built `TaskType` struct): a spec hash, a **verification
policy** (which `HumanContributionGate` mode verifies it), a **TASK-lane reward weight**
(`1e18` = equal-to-hash baseline; higher for harder/scarcer work), a **reputation gate**
(minimum tier required to take it), an **enabled** flag, and the net-new **two-buyer flag**
(is this contribution sellable to AI-training, to market-research, or both?).

### 3a. The RemoTasks half — trains the AI

- **Preference-ranking / RLHF.** Shown N model outputs, rank them and (often) say *why*.
  The single highest-volume, highest-leverage data type for aligning a model. **This is
  also the convergence task** — the same ranking is focus-group signal (§5).
- **SFT prompt/response.** Write a high-quality demonstration: a prompt and the ideal
  response. Supervised fine-tuning data.
- **Evaluation / red-teaming.** Probe the model for failures — jailbreaks, harmful
  outputs, factual errors, refusals-that-shouldn't-be. Adversarial labor that's scarce and
  valuable.
- **Annotation.** Label, classify, segment, transcribe, tag. The classic data-labeling
  workload.
- **Curation = the Library contribution.** Selecting, cleaning, and structuring source
  material *is* training data. PRANA's "Library" contribution (assembling a high-quality
  corpus) is a first-class task-type here, not a side activity — a curated corpus is among
  the most valuable things you can hand a model builder.

### 3b. The EXPERT tiers — the highest-value, hardest-to-source data

Gated to high reputation (and, where relevant, to a domain credential held in
`ReputationRegistry`), these carry the **highest reward weights** because the data is the
hardest in the world to source:

- **Ethnobotany / traditional plant knowledge** (a VKFRI-native strength).
- **Law** — statute/case reasoning, jurisdiction-specific judgement.
- **Theology / religious-studies** — doctrinal and textual expertise.
- **Crypto / protocol** — mechanism and security expertise.
- **Scholarship** — academic-grade citation, synthesis, and review.

Expert work is where models are starved for data and where general crowdwork can't reach.
This is also where the pay is **real money**, not supplemental micro-credit (§8).

### 3c. The survey / market-research half — sells opinion data

- **Surveys / polls.** Structured questionnaires; Likert scales; demographic-segmented
  panels.
- **Focus groups.** Moderated/structured discussion; deliberative feedback.
- **Market research / product feedback.** Concept tests, pricing studies, ad/creative
  evaluation, usability feedback.

The buyer-side economics, fraud problem, and licensing tie-in for this half are detailed
in the companion spec [`market-research-buyers.md`](./market-research-buyers.md) (AG17).

---

## 4. The convergence in detail — one contribution, two buyers

The double-sale is the design's center of gravity, so it's worth being precise about *how*
one act becomes two products.

Consider an RLHF preference-ranking task: "Here are two answers to a question about
sleep-aid herbs. Which is better, and why?" Captured once, the response is:

- **To a model builder (incl. Hathor):** a labeled preference pair — exactly the RLHF
  training signal used to fine-tune a reward model.
- **To a market-research client:** an opinion data point — *real humans, segmented by
  demographic and reputation, expressed a preference between two product framings and
  explained their reasoning.* That is a focus group.

The same is true of evaluation ("rate this output for clarity/helpfulness" = product
feedback), and of expert judgement ("which of these two legal summaries is correct" =
both a training label and a billable expert opinion).

The `HumanTaskRegistry` **two-buyer flag** marks which task-types are dual-sellable. When
a contribution clears the gate, its provenance record (see §6) tags it as AI-training,
market-research, or both — so the data-DAO (AG8) can license it down *both* channels and
split proceeds to the contributor. **The contributor is paid once through the pool for
doing the work; the data they produced is then a community asset that can be licensed
twice.** Doubling revenue per contribution is what lets the platform pay better than a
single-channel crowdwork site while still being honest about microtask economics.

---

## 5. Reward routing through the contribution engine

The flow from "a human did something" to "PRANA is owed to them," end to end:

```
contributor submits task result
        │
        ▼
HumanContributionGate (AG2)  ── verifies ──►  consensus/redundancy across N labelers
        │                                     + gold-task / honeypot known-answer check
        │                                     + attention / speed flags
        ▼  (one-shot verdict, consume()-pattern from TaskVerificationGate)
HumanTaskCreditor (AG5)  ── checks ──►  ProofOfHumanCredential (AG4): is this a verified human?
        │                          └─►  ReputationRegistry (AG3): does rep meet the task's gate?
        │
        ▼  reads governed weight from HumanTaskRegistry (AG1).shareWeight(taskId)
UnifiedSharesLedger (NN1).creditShares(contributor, Lane.TASK, weightedShares)
        │
        ▼
contributor's TASK-lane shares enter the same per-epoch PPLNS pool as hashers + GPUs;
claim() pays PRANA pro-rata over the rolling window.
```

Key properties inherited from the built stack:

- **Verify before pay.** Nothing credits the pool until the gate returns a verified,
  not-yet-consumed verdict. `consume()` is one-shot, so a verified contribution can be
  turned into pooled shares **exactly once** (the replay guard that stops double-credit —
  identical to `TaskVerificationGate.consume()`).
- **Recipient is gate-bound, not caller-controlled.** The creditor credits the worker the
  gate bound to the claim; an off-chain coordinator can't redirect pay to itself. (Same
  property `TaskLaneCreditor` already enforces.)
- **Weight is governed and live.** A task-type's reward weight is read from the registry
  at credit time, so the DAO can re-price task-types (e.g. raise expert weights) without
  redeploying the creditor.

### Gold-tasks (honeypots)

`HumanContributionGate` (AG2) includes **gold-tasks**: items with a known correct answer,
secretly mixed into a contributor's stream. Failing them flags low quality, can withhold
the credit, and feeds `ReputationRegistry`. This is the standard crowdwork quality control
(Scale/Surge/Prolific all use known-answer checks) plus **redundancy/consensus** scoring
across N independent labelers — the human analog of K-of-N attestation quorum.

### Reputation tiers

`ReputationRegistry` (AG3) is the Sapien model: contributors **earn non-transferable
reputation** for verified, consensus-passing, gold-task-clean work, which **unlocks
higher-value task tiers** (general → specialist → expert). They may also **stake PRANA**,
which is **slashed for garbage** — skin in the game. Reputation **decays slowly** so it
reflects current reliability, and it gates which rows of `HumanTaskRegistry` a contributor
may take. High rep + a domain credential is what opens the expert tiers in §3b.

### The proof-of-human gate (the moat)

`ProofOfHumanCredential` (AG4) is the **verified-human attestation** that gates everything
paying tradeable tokens and tags every contribution's provenance. It is built **without
heavy KYC** — the exact mechanism is **UD-AG-B**, a user decision (behavioral + reputation
+ stake, a privacy-preserving proof-of-personhood, or a Prolific-style phone/email/geo
screen), *not* picked here. The point is the property, not the mechanism: **verified
humans out-earn farmers**, and the data carries a buyer-visible verified-human provenance
flag. As the open web fills with bot/agent-generated survey fraud (see the companion
spec), that flag is the whole value proposition.

---

## 6. Data provenance — feeding the data-DAO

Every cleared contribution emits a provenance record: the task-type, the verified-human
flag (AG4), the contributor's reputation tier at submission, and the two-buyer
classification (AI-training / market-research / both). This record is what the **Data-DAO**
(AG8, spec'd in [`data-dao-spec.md`](./data-dao-spec.md)) licenses to outside AI builders
and researchers, splitting proceeds **pro-rata back to the contributors who produced the
dataset**. So a contributor is paid *twice* over time: once at credit (pool shares, §5),
and again as a pro-rata share of licensing revenue when their data is sold. The
verified-human corpus is simultaneously the moat and the product.

---

## 7. The worker app (gated)

The contributor-facing task UI + submission flow (AG7) is **SoapBox front-end scope** and
is **gated** pending a user scope decision (like PR7/I4). It is spec-only here. When built,
it is the human analog of the pool-worker daemon: present the next task from the registry,
collect the result, submit to the gate, surface accrued pool shares and licensing
earnings. No backend/server details are specified in this public repo.

---

## 8. Honest pay framing (do not oversell)

This matters and the spec is deliberately conservative about it:

- **Microtasks are supplemental value + ownership, not a salary.** Ranking answers and
  doing annotation in spare minutes earns pool credit, not a living wage. Per the broader
  crowdwork reality, general microtask pay is modest *(as of the doc / industry
  precedent)*. We say so plainly. The differentiator is **ownership**: the contributor's
  data becomes a community asset (the data-DAO) that keeps paying via licensing, and the
  pool credit is a real, claimable token — not points.
- **Expert tiers and focus groups pay real money.** Ethnobotany/law/theology/crypto/
  scholarship work, and structured focus groups, are where the dollars are — because the
  data is scarce and buyers pay accordingly. (Industry precedent: focus-group and
  specialist-panel rates are far above microtask rates; Prolific/Respondent pay real cash
  for studies.)
- **The double-sale funds better pay than single-channel crowdwork.** Because one
  contribution is sold to two buyers (§4), the platform can return more per contribution
  than a site that only sells to one side — without pretending microtasks are a job.

The promise we make is: *fair pay for the tier of work, real ownership of the data you
produce, and verified-human status that makes your contribution worth more as the rest of
the internet fills with bots.* Not "get rich doing surveys."

---

## 9. Precedents (real, cited)

- **Scale AI / RemoTasks / Outlier** — the data-labeling + RLHF labor marketplace this
  half is modeled on (RemoTasks/Outlier are Scale's contributor-facing brands).
- **Surge AI** — high-quality RLHF/eval human-data vendor; the quality-over-volume model.
- **Prolific** — verified-human research panel; now explicitly markets "high-quality human
  data for AI" — the convergence, validated by an incumbent (see companion spec).
- **Respondent** — professional/expert participant recruiting for research and interviews
  (the expert-tier + focus-group precedent).
- **Sapien** — crypto-paid decentralized data foundry with **stake + reputation slashing**;
  the direct precedent for `ReputationRegistry` (AG3).

---

## 10. Open user decisions referenced (not picked here)

- **UD-AG-A** — route human contribution through the existing TASK lane (recommended, no
  ledger-enum change) vs add a 4th `HUMAN` lane to `UnifiedSharesLedger`. This spec assumes
  the TASK-lane path.
- **UD-AG-B** — which proof-of-human mechanism (behavioral+rep+stake / privacy-preserving
  PoP / phone+email+geo screen). Sets moat strength vs onboarding friction.
