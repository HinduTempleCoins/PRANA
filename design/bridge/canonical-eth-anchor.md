# Canonical Bridge — ETH-anchored escrow design note (BI3)

> Scope: the **ETH-L1-anchored canonical bridge** for PRANA — why the immutable root of
> trust lives on Ethereum L1, where the federated validator set sits, the trust
> assumptions at each stage, and the path to a stage-3 light-client bridge. Design only:
> we do **not** deploy anything on Ethereum L1 here. Grounded in the built PRANA-side
> contracts `FederatedBridgeValidatorSet` and `CanonicalLockMintBridge`.

---

## 1. Why anchor to Ethereum L1 (not Polygon, not "trustless from day one")

PRANA is a **sovereign GPU-mined EVM L1** — it secures itself with its own hashpower and
never depends on any company's L2. But a bridge needs an external **root of trust** for
the assets that cross it. The decision (Build-Interop §3 / §13) is:

- **Escrow lives on Ethereum L1.** Ethereum is the security anchor of the EVM world; an
  escrow contract there is the immutable counter-balance to PRANA-native wrapped supply.
- **Funds can always exit via L1.** If Polygon (the convenience liquidity gateway) ever
  vanished, the canonical-bridge escrow on Ethereum is untouched — value still exits
  through L1. Polygon is a *path*, never the *foundation*.
- **Anchor security to Ethereum, not Polygon.** Polygon connectivity (see
  `PolygonEvmBridgeAdapter`, BI4) is a redundant, lower-trust path layered on top; it is
  never the canonical settlement layer.

This is the **TRON-vs-ETH** lesson from the Founding note: each wrapped deployment is a
separate contract per chain, so there is **one canonical wPRANA/wASSET bridge** anchored
to ETH, not many ad-hoc wraps.

---

## 2. The two endpoints and the escrow shape

The canonical bridge is a **lock-mint / burn-release** pair across two chains.

```
   Ethereum L1                                   PRANA L1
 ┌──────────────────┐    attested deposit     ┌────────────────────────┐
 │  L1 Escrow       │  ───────────────────▶   │ CanonicalLockMintBridge │
 │  (lock canonical │   (K-of-N validator     │  .mint(...) → wrapped    │
 │   asset, emit    │    quorum signs the     │  mint to recipient       │
 │   (chainId,nonce))│   (to,amount,src,nonce)│                         │
 │                  │   ◀───────────────────  │  .burn(...) → Withdrawal │
 │  release on      │    burn-to-release      │  emits (dstChainId,...)  │
 │   attested burn  │                         └────────────────────────┘
 └──────────────────┘
```

### L1 escrow contract shape (design target — not deployed here)
A minimal, audit-friendly vault:
- **`lock(token, amount, dstPranaAddr)`** — pulls the canonical ERC-20 into escrow, emits
  `Locked(srcChainId, nonce, token, amount, dstAddr)` with a strictly-monotonic `nonce`.
  This is the event PRANA-side validators attest before `CanonicalLockMintBridge.mint`.
- **`release(to, amount, sigs, pranaWithdrawalNonce)`** — the mirror of the PRANA `burn`
  path: releases escrowed funds when a validator quorum attests a PRANA-side `Withdrawal`
  event. Per-`(pranaChainId, withdrawalNonce)` replay guard.
- **Guardrail stack identical to the PRANA side**: pause/guardian, per-token + global
  rolling-window rate limits, and a withdrawal time-lock delay. These mirror the §13
  guardrails the PRANA endpoint already carries (`CanonicalLockMintBridge` has
  `PAUSER_ROLE`; the validator set carries the rate-limit/timelock governance hooks).
- **Immutability bias.** The escrow logic is intended to be minimal and frozen; only the
  validator-set membership and rate-limit parameters are governable, and those changes are
  themselves timelocked.

### The PRANA endpoint already exists
`contracts/bridge/CanonicalLockMintBridge.sol`:
- `mint(to, amount, srcChainId, nonce, sigs)` — anyone (a relayer) may submit; security is
  in the signatures, not the caller. Per-`(srcChainId, nonce)` replay guard via the
  `processed` mapping.
- `burn(amount, dstChainId, dstAddr)` — burns the caller's wrapped supply (`burnFrom`) and
  emits `Withdrawal` with a monotonic `withdrawalNonce` for the L1 escrow to release
  against.
- `hashMint(...)` binds the signed digest to `block.chainid` **and** `address(this)`, so a
  signature cannot be replayed onto another bridge deployment or another chain.

---

## 3. Where the federated validator set sits

`contracts/bridge/FederatedBridgeValidatorSet.sol` (BI1) is the **shared K-of-N signer set**
both endpoints query live:

- It holds the validator addresses (`EnumerableSet`) and the quorum threshold **K**.
- `verifySignatures(digest, sigs)` returns true iff ≥ K **distinct** current validators
  signed the EIP-191 form of `digest`. Duplicate or non-validator signatures are ignored.
- Membership and K are governed by `DEFAULT_ADMIN_ROLE` — intended to be the **PRANA DAO /
  timelock** — via `addValidator` / `removeValidator` / `rotateValidator` / `setThreshold`.
  `removeValidator` refuses to drop N below K (quorum must stay reachable).

The **same validator set instance** can gate the L1 escrow, the PRANA canonical endpoint,
the Polygon adapter (BI4), and the Graphene deposit bridge (BI7) — one DAO-governed trust
root across all federated paths, or distinct sets per path if the DAO wants blast-radius
isolation. Because the set is queried **live**, rotating a key or changing K takes effect
immediately for every signature bundle verified afterward.

---

## 4. Trust assumptions (honest framing)

| Stage | Mechanism | Trust assumption |
|-------|-----------|------------------|
| **Stage 1** | single market per chain | no bridge; each chain trades its own assets |
| **Stage 2** | single custodian (`PeggedBridgeVault`) | ONE key is fully trusted |
| **Stage 2.5 (here)** | K-of-N federated (`FederatedBridgeValidatorSet` + `CanonicalLockMintBridge`) | **K-of-N validators honest**; a colluding quorum could mint unbacked supply |
| **Stage 3 (target)** | trustless light client | cryptographic proof of the L1 event; no honest-majority assumption |

The current build is **Stage 2.5**: strictly stronger than the single-custodian stub
(`PeggedBridgeVault`), strictly weaker than a light-client bridge. Per §13 the rule is
"start **trust-minimized-federated**, not hand-rolled-trustless." The blast radius of a
compromised quorum is bounded by the guardrail stack (rate limits, pause, withdrawal
time-lock) so a malicious mint cannot drain escrow faster than the limits and the guardian
allow.

---

## 5. Finality / confirmation-depth policy

Validators must not attest a deposit until the source-chain event is **economically final**:
- **From Ethereum L1 → PRANA:** wait for a conservative confirmation depth (post-Merge L1
  finality is ~2 epochs / ~13 min; a conservative policy waits for finalized checkpoints,
  not just N blocks). The deposit `nonce` is only attested after finality.
- **From PRANA → L1:** because PRANA is PoW and young (low bootstrap hashpower at launch,
  §2/§13), use a **deep** confirmation depth on the PRANA side before the L1 escrow
  releases — deeper than a mature chain would need, tightened as hashpower grows. This is
  the "conservative bridge finality until deep" rule.
- Confirmation depths are **governable parameters** (DAO/timelock), per-direction.

---

## 6. Failure-mode matrix (§13)

| Failure | Effect | Mitigation already in place / designed |
|---------|--------|----------------------------------------|
| Polygon dies | only the EVM-liquidity-via-Polygon path degrades | canonical escrow on ETH L1 is untouched; funds exit via L1; wMELEK/wVKBT still live on PRANA |
| One validator key compromised | no effect below quorum | K-of-N: need K keys; rotate the bad key via `rotateValidator` |
| K-of-N collude | could mint unbacked supply | rate limits + pause + withdrawal time-lock bound the loss; DAO can pause + replace the set; audits + monitoring + bounty (§13) |
| Replay of a deposit | none | per-`(srcChainId, nonce)` `processed` guard on PRANA; mirror per-`(chainId, nonce)` guard on L1 |
| Cross-bridge signature reuse | none | `hashMint` binds `block.chainid` + `address(this)` into the digest |
| Reorg on a source chain before finality | none | confirmation-depth / finality policy (§5) — attest only after final |
| Relayer censorship / liveness | delayed, not lost | `mint` is permissionless (any relayer can submit a valid bundle); user can self-relay |

---

## 7. Path to stage-3 (light-client bridge)

The federated set is the **bridge-of-the-bridge**: it stands in for a proof that PRANA
cannot yet verify on-chain. The migration path:
1. **Now** — K-of-N federated, DAO-governed set, full guardrail stack. (Built.)
2. **Add redundant messaging paths** — Hyperlane / LayerZero-OFT / Axelar / CCIP behind
   the pluggable `MessagingBridgeAdapter` (BI5) so there is no single chokepoint (§3).
3. **Lean on AggLayer pessimistic proofs** for the EVM↔EVM (Polygon) leg where available
   (§13) — damage-containment without full trustlessness.
4. **Stage 3** — replace `verifySignatures` gating with **on-chain verification of an
   Ethereum consensus proof** (sync-committee / light-client proof of the `Locked` event).
   The endpoint interface (`mint` consuming a proof bundle, replay-guarded by
   `(srcChainId, nonce)`) is designed to keep its shape; only the *gate* changes from
   "K validators signed" to "a valid consensus proof was supplied." Audited, last.

---

## Cross-references
- `contracts/bridge/FederatedBridgeValidatorSet.sol` — BI1, the K-of-N set.
- `contracts/bridge/CanonicalLockMintBridge.sol` — BI2, the PRANA mint/burn endpoint.
- `contracts/PeggedBridgeVault.sol` — the single-custodian stub this design supersedes.
- `design/bridge/messaging-adapters.md` — BI5, redundant messaging paths.
- `design/bridge/melek-relayer-spec.md` / `hive-engine-relayer-spec.md` — the non-EVM
  (Graphene) relayer bridges that reuse the same validator-set trust model.
