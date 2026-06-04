# HORIZON — Tier-3 node-builder spec (BI17)

> Scope: **HORIZON**, the Tier-3 node-based visual builder for designing the *relationships*
> that give NFTs and currencies value. Front-end spec — HORIZON is a UI/UX layer that
> **emits configurations and transactions** against contracts that already exist; it adds no
> new trust and stores no value itself. Sits at the top of the NFT value ladder
> (`design/nft/value-ladder-tiers.md`, BI18). Spec only.

---

## 1. What HORIZON is

A **ComfyUI-shaped, drag-and-wire visual editor**. Where ComfyUI wires image-generation
nodes into a pipeline, HORIZON wires **economic-relationship nodes** into a deployable
design: "this NFT collection feeds royalties into that split, which buys back this token on
the DEX, which gates entry to that marketplace tier." The builder's job is to let a
non-Solidity creator **compose existing PRANA primitives** into a value structure, with AI
doing the heavy lifting (suggesting wirings, filling parameters, explaining tradeoffs).

HORIZON is **Tier-3** of the NFT builder ladder:
- **Tier-1** — form wizard (the deploy-wizard backend, already built: `akasha/tools/deploy-wizard.mjs`
  driving `NFTFactoryWizard` / `ERC20FactoryWizard`). One form → one deployed, owned contract.
- **Tier-2** — template-clone (pick a pre-wired template, fill the blanks, clone it).
- **Tier-3 — HORIZON** — free-form node graph for arbitrary relationships between many
  contracts.

HORIZON **does not replace** Tiers 1/2; it sits above them and can drop a Tier-1/Tier-2
deploy into a node on its canvas.

---

## 2. The node model

A HORIZON document is a **directed graph** of typed nodes and typed edges. Every node maps
to a real, already-built PRANA contract or a deploy-wizard action. Examples:

| Node | Backed by | What wiring it expresses |
|------|-----------|--------------------------|
| **Collection** | `NFTFactoryWizard` → `RoyaltyNFT` | deploy/own an ERC-721 with EIP-2981 royalties |
| **Token** | `ERC20FactoryWizard` | deploy/own an ERC-20 |
| **Royalty split** | `RevenueSplitter` / 0xSplits-style | fan royalty income to addresses by weight |
| **Buyback** | `CommunityBuybackVault` (BI13) | route yield → market-buy a token on MELEKSwap |
| **Gauge / emission** | `LiquidityGauge` / `GaugeController` | direct emissions to an LP |
| **Burn-mine** | `BurnMine` / `MultiCurrencyBurnRouter` | lock/burn token A → mint token B |
| **Marketplace tier** | `RoyaltyMarketplace` + `MarketplaceReputation` (BI19) | list at a value-ladder rung with reputation weight |
| **Fee rebate** | `FrontEndFeeRebate` (BI20) | lower fee when traded through a registered front-end |
| **Crowd-stake** | `CrowdStaking` (BI11) + `DAOFundEmissionSplit` (BI12) | delegate-to-earn with a DAO slice |

**Edges are typed** (an address output → an address input, a "royalty sink" output → a
"funded vault" input). The editor only allows edges the contract ABIs actually support, so
a valid graph is a deployable wiring. Invalid wirings are rejected at edit time, not at
deploy time.

---

## 3. Build → deploy pipeline

```
  canvas graph  ──▶  validate (typed edges, required params)
                ──▶  topological order (deploy dependencies first)
                ──▶  per-node deploy/config tx plan (reuses Tier-1 deploy-wizard payloads)
                ──▶  user reviews + signs (their wallet; HORIZON never custodies keys)
                ──▶  post-deploy: emit verification payloads (explorer) + a saved graph doc
```

- HORIZON **compiles the graph into an ordered transaction plan**; each tx is signed by the
  **creator's own wallet** (HORIZON is non-custodial — same boundary as the rest of Akasha).
- Where two nodes must reference each other (e.g. a collection's royalty receiver = a split
  contract), HORIZON resolves the dependency order and threads deployed addresses forward.
- The saved graph is a portable JSON document (re-openable, cloneable into a Tier-2
  template) — it is the *source* the AI assistant and the deploy planner both read.

---

## 4. AI assistance (heavy-lifting, not authority)

The AI assistant (Hathor-class, read-only over chain state per `Build-Interop §12`):
- suggests node wirings for a stated goal ("I want a collection whose secondary royalties
  buy back my community token"),
- fills sensible default parameters and **explains the economic consequence** in plain
  language,
- flags risky shapes (e.g. an emission with no sink — violates faucet/sink discipline).

The AI **never signs and never holds value** — it proposes a graph; the human reviews and
signs. This keeps HORIZON inside the same non-custodial, advice-not-authority boundary the
ecosystem uses for agents.

---

## 5. BEE-fee anti-spam gating

Per §10, the builder is **BEE-fee anti-spam gated**: actions that create on-chain weight
(deploys, registrations) carry a small protocol fee / burn so the canvas cannot be used to
spam cheap throwaway contracts. The fee is a value-ladder primitive (it can itself route to
a burn-mine or the DAO fund), not a new mechanism — HORIZON simply requires it on
deploy-class nodes.

---

## 6. What HORIZON deliberately is NOT

- **Not a new contract.** It deploys/configures existing audited primitives; a bug in the
  builder cannot mint or move value beyond what the signed txs do.
- **Not custody.** No keys, no pooled funds.
- **Not a Solidity IDE.** It composes primitives; it does not author arbitrary bytecode
  (that is the audited-contract path, outside HORIZON).

---

## Cross-references
- `design/nft/value-ladder-tiers.md` — BI18, Tiers 1/2 below HORIZON + the value-ladder rungs.
- `contracts/NFTFactoryWizard.sol` — Tier-1 NFT deploy backend (YY1).
- `akasha/tools/deploy-wizard.mjs` — the Tier-1 deploy-wizard CLI HORIZON nodes reuse.
- `contracts/MarketplaceReputation.sol` / `FrontEndFeeRebate.sol` — BI19/BI20 marketplace nodes.
- `CommunityBuybackVault` / `CrowdStaking` / `DAOFundEmissionSplit` — BI11–13 economic nodes.
