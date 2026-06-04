# Indie-game platform spec (BI21)

> Scope: an **itch.io-style indie-game platform** on PRANA — self-publish games, assets, and
> music; creator-set pricing; game jams; functional-NFT items with an EVM value anchor;
> a no-Solidity creator SDK. Spec only. The platform is a front-end + indexing layer over
> contracts that already exist; it introduces no new custody and no new trust.

---

## 1. The model (itch.io, on-chain anchored)

itch.io's shape: **anyone self-publishes**, the creator sets the price (including
pay-what-you-want and free), buyers get a download, and there are **jams** (time-boxed
community events). PRANA keeps that openness and adds:
- **Functional NFTs** for in-game items, with a **WAX-style feeless mint** for the
  high-frequency item layer and an **EVM value anchor** on PRANA for anything that holds or
  trades value.
- **Token-set pricing** — creators price in PRANA / wMELEK / a community token; fiat (if
  ever) only at the **SOAP edge**, never inside the platform economy.
- A **no-Solidity SDK** (Thirdweb-style): token-gating, embedded-wallet, and mint/list
  calls exposed as plain SDK functions so a game dev never writes a contract.

---

## 2. What it reuses (already built)

| Need | Contract / tool |
|------|-----------------|
| Publish a collection of items | `NFTFactoryWizard` → `RoyaltyNFT` (owned, EIP-2981 royalties) |
| Fungible game/community currency | `ERC20FactoryWizard` + the deploy-wizard |
| List / sell items, secondary royalties | `RoyaltyMarketplace` (fixed-price, escrowed) |
| Seller trust by value-ladder rung | `MarketplaceReputation` (BI19) |
| Front-end fee incentive | `FrontEndFeeRebate` (BI20) — publish through our front-end, lower fee, never lockout |
| Token-gated content/rooms | `SubscriptionLockNFT` + the SIWE/GateRegistry gate stack |
| Item stats / inventory | game-suite contracts (`ItemRegistry` ERC-1155, `MutableStatNFT`) |
| Deploy without Solidity | `akasha/tools/deploy-wizard.mjs` (the Tier-1 backend) |

The platform is the **storefront + indexer + SDK** over these; it does not re-implement
escrow, royalties, or minting.

---

## 3. The two-layer item model (functional NFT + EVM anchor)

- **Functional layer (high-frequency, feeless).** In-game items that mint/burn constantly
  (consumables, drops) live on a feeless functional-NFT rail (WAX-pattern). These are cheap
  and disposable; they are *not* the value store.
- **Value-anchor layer (EVM, on PRANA).** Items that hold or trade value graduate to an
  `RoyaltyNFT` on PRANA, where they get EIP-2981 royalties, marketplace listing, and the
  value-ladder/escrow protections. The platform decides the rung (see
  `design/nft/value-ladder-tiers.md`): a cosmetic is R2 (digital+utility); a redeemable
  physical reward is R3.

This split keeps gameplay cheap while value-bearing items inherit real protection.

---

## 4. Creator flow

```
 1. Creator signs up (wallet-based identity; no custody by the platform).
 2. Publishes a game/asset/music page: title, media, price (in token), optional jam tag.
 3. (optional) Deploys an item collection via the no-Solidity SDK → NFTFactoryWizard.
 4. Lists items on RoyaltyMarketplace; sets royalty %.
 5. Buyers pay in token; creator is paid directly (escrow only where the rung needs it).
 6. The platform indexes everything via The Graph (see analytics-spec.md) for discovery.
```

**Jams** are an off-chain organizing layer (a tag + a deadline + a leaderboard) over the
same publish flow; prizes, if tokenized, route through existing reward primitives (e.g. a
Merkle distributor or `ArcadeLeaderboard`).

---

## 5. Guardrails

- **No custody.** The platform never holds creator keys or pooled user funds; payments
  settle peer-to-peer or through the marketplace escrow contract, not a platform wallet.
- **Value-ladder compliance.** Higher rungs (real-goods, redeemables) carry the heavier
  escrow/reputation and the money-transmitter/securities boundary (§13) — fiat at the SOAP
  edge only.
- **Open by default.** Self-publish is permissionless; the front-end-fee incentive (BI20)
  rewards using our front-end but **never locks anyone out** of the underlying contracts.

---

## Cross-references
- `design/nft/value-ladder-tiers.md` — the rung model items graduate along.
- `design/marketplaces/agent-marketplace.md` — sibling marketplace (agents).
- `design/marketplaces/analytics-spec.md` — the discovery/indexing layer.
- `contracts/RoyaltyMarketplace.sol`, `MarketplaceReputation.sol`, `FrontEndFeeRebate.sol`,
  `NFTFactoryWizard.sol` — the reused contracts.
