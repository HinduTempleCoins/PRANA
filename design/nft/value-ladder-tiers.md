# NFT value-ladder — Tier-1 / Tier-2 spec + the digital→physical rung model (BI18)

> Scope: the two builder tiers **below** HORIZON (BI17) — Tier-1 form wizard and Tier-2
> template-clone — and the **digital→physical value-ladder** that the marketplace trust
> tiers ride on. Spec only. Tier-1's backend already exists (the deploy-wizard +
> `NFTFactoryWizard`); this document specifies the tier model and the rung semantics.

---

## 1. The builder tiers (three rungs of "how much wiring")

| Tier | Form factor | Backend | Who it is for |
|------|-------------|---------|---------------|
| **Tier-1** | a **form wizard** — fill a form, get one deployed contract | `akasha/tools/deploy-wizard.mjs` → `NFTFactoryWizard` (NFT) / `ERC20FactoryWizard` (token) — **already built** | anyone; zero crypto knowledge |
| **Tier-2** | **template clone** — pick a pre-wired template, fill the blanks, clone it | template registry + the same factories; EIP-1167 minimal-proxy clones where cheap (`ClonesFactory`) | creators who want a known-good shape (e.g. "gated game-item collection") without designing it |
| **Tier-3** | **HORIZON** node-builder (free-form graph) | see `design/nft/horizon-builder-spec.md` | designers wiring arbitrary value relationships |

### Tier-1 (the form wizard) — already real
`NFTFactoryWizard` deploys a role-gated mintable `RoyaltyNFT` (ERC-721 + EIP-2981
royalties), grants admin+minter to the caller, and renounces the factory's own rights — so
the creator **owns** the collection outright after one call. The deploy-wizard CLI builds
the call and emits the explorer-verification payload. One form → a live, owned, verifiable
collection. This is the **Tier-1 backend the queue notes "already exists."**

### Tier-2 (template clone) — spec
- A **template** is a saved, parameterized wiring (a named Tier-1 config, or a small
  HORIZON sub-graph) marked clonable.
- "Clone" = re-run the underlying factory/deploy plan with the user's parameters; where the
  contract is clone-friendly, use **EIP-1167 minimal proxies** (`ClonesFactory`) to keep gas
  low and bytecode identical (and thus trivially verifiable).
- Templates carry their **value-ladder rung** (below) so the marketplace knows the trust
  weight a clone inherits.
- Templates are themselves an output of Tier-3: a creator designs a wiring in HORIZON, marks
  it a template, and others clone it at Tier-2.

All three tiers are **BEE-fee anti-spam gated** on deploy-class actions (§10).

---

## 2. The digital→physical value ladder (the rung model)

The "why is this worth anything" axis. Each rung adds real-world weight and therefore needs
more escrow, reputation, and (at the top) money-transmitter/compliance care. The marketplace
trust-tier contracts (`MarketplaceReputation`, BI19) scale escrow/reputation by **rung**.

| Rung | What the NFT is | Backing | Trust weight | Maps to |
|------|-----------------|---------|--------------|---------|
| **R1 — digital collectible** | a pure collectible (CryptoKitties-style) | scarcity + rarity + demand only | lightest | `RoyaltyNFT` + `RoyaltyMarketplace` |
| **R2 — digital + utility** | a productive/usable item (game item, access pass) | does something on-chain (gates, boosts, stakes) | light–medium | game-item contracts, `SubscriptionLockNFT`, gauges |
| **R3 — digital representing real** | a **claim** on a real-world good (WAX vIRL-style) | a redeemable claim to a physical item | heavy | `MarketplaceReputation` heavier tier + a redemption flow (cf. `PhysicalCardRedemption`) |
| **R4 — real goods for tokens** | an eBay-style sale of a physical good priced in tokens | the actual delivery of goods | heaviest | tiered escrow + reputation + (compliance: money-transmitter/securities review) |

**Honest framing (per §10):** higher rungs are *not* automatically "better." CryptoKitties
(R1) is an honest collectible; "productive" NFTs (R2/PGL-style) come with real crash risk
that must be framed honestly, never as a price-floor promise. The ladder is about **what
backs the value and therefore how much protection a trade needs**, not a hype gradient.

---

## 3. How the rung drives marketplace protection

`MarketplaceReputation` (BI19) gives each seller an on-chain reputation that the marketplace
reads, and the **rung sets the escrow policy**:
- **R1/R2** — light escrow; reputation is informational; secondary royalties flow via
  EIP-2981 (`RoyaltyMarketplace`).
- **R3** — escrow holds funds until the **redemption/claim** is fulfilled; reputation
  weighted heavier; disputes reported back into the reputation score.
- **R4** — heaviest escrow + reputation, and the **compliance boundary** (money-transmitter
  / securities, the §13 "wrapped value touches securities/money-transmitter → utility
  framing + licensed fiat rails" rule). USD/fiat lives only at the **SOAP edge**, never
  inside the internal economy.

The `FrontEndFeeRebate` hook (BI20) is orthogonal: any rung traded through a registered
front-end can earn a lower fee (Proof-of-Burn incentive, never a lockout).

---

## 4. Cross-references
- `design/nft/horizon-builder-spec.md` — BI17, Tier-3 above these tiers.
- `contracts/NFTFactoryWizard.sol` — Tier-1 NFT factory (YY1).
- `akasha/tools/deploy-wizard.mjs` — the Tier-1 deploy-wizard CLI backend.
- `contracts/RoyaltyNFT.sol` / `RoyaltyMarketplace.sol` — R1/R2 primitives.
- `contracts/MarketplaceReputation.sol` — BI19, the per-rung reputation/escrow weight.
- `contracts/FrontEndFeeRebate.sol` — BI20, the front-end fee incentive.
- `contracts/PhysicalCardRedemption.sol` — an R3 redemption precedent (NFC/QR → claim).
