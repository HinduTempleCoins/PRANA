# Market-Research Buyer Side — Selling Verified-Human Opinion Data

**Backlog item:** AG17 (`tools/brain/state/QUEUE-from-docs-9.md` §E).
**Source doc:** "PRANA — AI & GridCoin Engine" §6 (the buyer side / data-quality crisis).
**Status:** architecture note (spec/doc). Companion to the platform spec
[`platform-spec.md`](./platform-spec.md) (AG6) and the data-DAO spec
[`data-dao-spec.md`](./data-dao-spec.md) (AG9). No new code in this file.

> Figures marked *(as of the doc / approximate)* are taken from the source document or
> cited public reporting and are illustrative, not pinned numbers.

---

## 1. The one-line idea — sell the same verified-human data we collect to train the AI

The human-training platform (AG6) collects verified-human contributions to make models
better. **That exact same data is a product the market-research industry already buys.** A
preference ranking is RLHF training data to a model builder *and* a focus-group signal to a
brand. This spec is the **buyer side**: who pays for verified-human opinion data, why the
industry is in crisis, and how that crisis *inverts* into PRANA's value proposition.

The revenue model is the **two-buyer / double-sale** from the platform spec §4: one
contribution, sold to (a) model builders incl. PRANA's own Hathor, and (b)
market-research clients. This document is about side (b).

---

## 2. Who buys, and the precedents (real, cited)

The buyers are **businesses and researchers** who need responses from real, qualified
humans:

- Brands and product teams (concept tests, pricing, ad/creative evaluation, usability).
- Academic and policy researchers (survey panels, experiments, interviews).
- AI labs buying human evaluation and preference data (the convergence — they're side (a)
  *and* increasingly side (b)).

Established platforms that already run this market, and what each proves for PRANA:

- **Prolific** — a vetted online research-participant panel. Critically, Prolific now
  explicitly markets **"high-quality human data for AI,"** not just academic surveys. An
  incumbent has publicly fused the survey-panel business with the AI-training-data business
  — i.e. validated **the convergence** PRANA is built around.
- **Respondent** — recruiting of professional/expert participants for paid research
  studies and interviews; the precedent for the **expert-tier + focus-group** buyer.
- **Sapien** — a **crypto-paid, decentralized data foundry** with on-chain **reputation +
  staking/slashing**. The direct precedent that selling human data to AI/research buyers
  *and* paying contributors in crypto with reputation-weighting is a working model, not a
  hypothesis.
- **Surge AI / Scale (RemoTasks/Outlier)** — the data-vendor side: enterprises pay
  premium rates for high-quality, human-verified labeling and evaluation.

PRANA's offer to these buyers is differentiated on one axis they increasingly can't get
elsewhere: **provable verified-human, reputation-scored, community-owned** data.

---

## 3. The data-quality crisis (the problem that becomes our moat)

The market-research and survey industry is large and structurally broken by automation:

- **Scale.** On the order of **~5 billion surveys per year** are run *(as of the doc /
  industry estimate)* — an enormous, established spend on opinion data.
- **Bot and AI-agent fraud.** Survey panels are increasingly polluted by bots, click-farms,
  and — newly — **LLM agents** that can pass attention checks and write plausible free-text,
  fraudulently collecting incentives and poisoning the data. As capable agents get cheaper,
  this gets worse, not better.
- **The "20% → 3%" finding.** Industry/academic reporting has found that on a raw survey
  sample a large fraction of responses can be fraudulent or low-quality, but on a
  **cleaned, verified-human sample** the fraud rate collapses *(reported as roughly 20%
  down to ~3% on a clean sample — as of the doc)*. The gap between raw and verified is the
  whole problem — and the whole opportunity.

**The inversion (the key §6 insight):** the worse the industry's bot problem gets, the
**more** a verified-human, reputation-scored, community-owned data network is worth. Every
incremental improvement in bot/agent capability *raises* the price of provably-human data.
PRANA's moat is counter-cyclical to AI progress: as AI makes fake responses cheaper and
more convincing, real-human-attested data becomes scarcer and more valuable. We are not
fighting the rising tide of synthetic data — we are selling the thing it makes scarce.

---

## 4. How PRANA's properties answer the crisis

Each buyer pain maps to a property already specified in the platform spec and its contracts:

| Buyer pain | PRANA answer | Where it lives |
|---|---|---|
| "Is this respondent a real human?" | `ProofOfHumanCredential` (AG4) — verified-human gate, buyer-visible provenance flag | platform spec §5–6 |
| "Is this respondent reliable / not a farmer?" | `ReputationRegistry` (AG3) — non-transferable, slow-decaying rep + slashable stake | platform spec §5 |
| "Are these responses low-effort / bot-passing?" | `HumanContributionGate` (AG2) — gold-tasks, consensus/redundancy, attention/speed flags | platform spec §5 |
| "Can I trust the data's origin?" | per-contribution provenance record (verified-human flag, rep tier, two-buyer class) | platform spec §6 |
| "Do incentives align with quality?" | stake-at-risk + reputation tiers; verified humans out-earn farmers | platform spec §5, §8 |

The result is a dataset whose **per-response trust is provable on-chain**, which is exactly
what a buyer paying for a clean sample wants — and what raw panels cannot offer.

---

## 5. The data-DAO licensing tie-in

The buyer relationship is mediated by the **Data-DAO** (AG8, spec'd in
[`data-dao-spec.md`](./data-dao-spec.md)). The verified-human corpus is treated as a
**community asset**:

- Outside AI builders **and** market-research clients **license** the data (or commission
  fresh collection) rather than buying a one-off deliverable from a vendor who keeps the
  margin.
- Licensing proceeds are split **pro-rata back to the contributors** who produced the
  licensed data — so contributors are paid both at collection (pool shares, platform spec
  §5) and again on every license of their data.
- The two-buyer flag on each contribution lets the same dataset be licensed down **both**
  channels (AI-training and market-research), realizing the double-sale at the revenue
  layer.

This is the structural difference from Scale/Prolific/Surge: there, the contributor is paid
once and the platform owns the data and the recurring margin. In PRANA, **the contributors
own the corpus** (via the data-DAO) and share in its recurring licensing revenue. That
ownership is also a recruiting and retention advantage — and another reason verified humans
choose to participate rather than farm.

---

## 6. Why this is defensible

- **Counter-cyclical moat.** The value of verified-human data rises with AI capability
  (§3). Competitors built on raw panels degrade as agents improve; PRANA's value grows.
- **On-chain provenance is hard to fake.** Reputation is non-transferable and slow-decaying;
  stake is slashable; the human gate tags provenance. A buyer can verify the trust chain
  rather than trust a vendor's word.
- **Community ownership compounds.** Pro-rata licensing revenue gives contributors a reason
  to keep producing high-quality, verified work — which is precisely the supply a
  fraud-plagued industry is short of.

---

## 7. Precedents recap (real, cited)

- **Prolific** — research panel now marketing "high-quality human data for AI" (the
  convergence, from an incumbent).
- **Respondent** — paid professional/expert participant recruiting (expert + focus-group
  buyer).
- **Sapien** — crypto-paid decentralized data foundry with reputation + staking/slashing.
- **Scale AI / RemoTasks / Outlier** and **Surge AI** — the enterprise data-vendor side
  buyers pay premium rates to.

---

## 8. Open user decisions referenced (not picked here)

- **UD-AG-B** — the proof-of-human mechanism. The strength of the verified-human flag —
  and therefore the premium buyers will pay over a raw panel — depends on this choice. Not
  picked here.
