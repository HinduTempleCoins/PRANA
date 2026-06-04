# Analytics platform spec — DappRadar/StateOfTheDapps replacement (BI23)

> Scope: a **chain-analytics / dapp-discovery platform** for PRANA — the gap left by
> StateOfTheDapps and DappRadar (both effectively shut down / degraded). A read-only
> indexing + presentation layer fed by **The Graph indexing PRANA**. Spec only — no server,
> host, or backend-infrastructure content (that lives, if anywhere, in the private vault).

---

## 1. The gap

**StateOfTheDapps** (the original Ethereum dapp registry) and **DappRadar** (the dominant
dapp-analytics aggregator) are gone / hollowed out. There is no good open "what's live on
this chain, and how is it doing" surface — and PRANA needs one for discovery
(games/marketplaces), transparency (the **Clarity Score** ethos), and as a feed for
Hathor's read-only views. This platform fills that gap **for PRANA first**.

---

## 2. Architecture (read-only, indexer-fed)

```
   PRANA L1 events ──▶ The Graph subgraphs (per contract group) ──▶ GraphQL API ──▶ UI
                                       │
                                       └──▶ Clarity/transparency scoring layer
```

- **The Graph indexes PRANA.** Subgraphs over the deployed contract groups (DEX, gauges,
  burn-mines, marketplaces, governance, compute ledger) turn raw events into queryable
  entities. This reuses the existing **subgraph adapter + manifest skeleton** (W4) and the
  data-shape work already specified (the `swap.*` / `vote.* / pool.*` shapes, Y3/Y4/Y5, and
  the chain-stats exporter, R2).
- **No new on-chain contract.** Analytics is strictly **read-only** over chain state and
  events; it adds no trust and holds no value.
- **The UI** presents per-dapp pages (TVL, volume, users, fees), rankings, and a chain
  overview; the condenser/aggregator feed already specified (Y7) can plug into the same data.

---

## 3. What it tracks

| Category | Source entities | Fed by |
|----------|-----------------|--------|
| DEX / liquidity | pairs, reserves, volume, LP fees | MELEKSwap V2 events → `swap.*` shape (Y3) |
| Gauges / emissions | gauge weights, stake, emissions | `LiquidityGauge` / `GaugeController` → `pool.*` (Y5) |
| Governance | proposals, votes, turnout | `GovernorDAO` events → `vote.*` (Y4) |
| Burn-mines | locked TVL, mint ratios, sinks | `BurnMine` / `MultiCurrencyBurnRouter` |
| Marketplaces | listings, sales, royalties, reputation | `RoyaltyMarketplace` / `MarketplaceReputation` |
| Compute | shares, lanes, payouts | `UnifiedSharesLedger` |
| Chain health | height, gas, supply, difficulty | the read-only chain-stats exporter (R2), difficulty-as-health (PR12) |

---

## 4. The Clarity / transparency score (the differentiator)

DappRadar ranks by raw volume; PRANA adds a **transparency/Clarity dimension** (per the R4 /
Y6 transparency-score spec): a dapp is scored not just on size but on **how legible it is** —
verified contracts, honest faucet/sink balance, no hidden admin powers, disclosed parameters.
This is the analytics expression of the ecosystem's "Clarity-first" ethos and the natural
input for Hathor's read-only Clarity Score (§12). The scoring layer is a pure function over
indexed data; its fields are defined in the Y6 transparency-score spec.

---

## 5. Guardrails

- **Read-only.** No writes, no custody, no privileged on-chain role.
- **Open data.** Built on The Graph's public subgraphs so anyone can re-derive the numbers —
  consistent with the transparency ethos (the analytics platform should itself be legible).
- **Public-safe.** This spec contains no host/server/IP/backend details; deployment topology
  is out of scope here.

---

## Cross-references
- The subgraph adapter + manifest (W4) and chain-stats exporter (R2) — the indexing inputs.
- The `swap.*` / `vote.* / pool.*` data shapes (Y3/Y4/Y5) and the condenser feed (Y2/Y7).
- The transparency/Clarity score field spec (R4 / Y6).
- `design/research/oracle-vs-oracalization.md` — how Hathor reads this data read-only.
- `design/marketplaces/indie-game-platform.md`, `agent-marketplace.md` — discovery consumers.
