# Hive-Engine → wVKBT relayer spec (BI9)

> Scope: the **off-chain relayer/watcher** that bridges Hive-Engine side-chain tokens
> (VKBT / CURE) to PRANA, driving the same `GrapheneDepositBridge` (BI7) as the MELEK
> relayer. Spec only — no servers, IPs, credentials, or host content. This is the
> **Hive-Engine-sourced twin** of `design/bridge/melek-relayer-spec.md`; only the *source
> read model* differs. Read that document first — the K-of-N model, flows, retry
> semantics, and onboarding are identical and are not repeated in full here.

---

## 1. What is different from the MELEK relayer

| | MELEK relayer (BI8) | Hive-Engine relayer (BI9) |
|--|--|--|
| Source chain | MELEK (Graphene / BLURT-fork base layer) | Hive-Engine sidechain (a fork of `hive-engine/steemsmartcontracts`) |
| Token type | native MELEK + MELEK-Power + MELEK-Engine SMTs | Hive-Engine **side-chain tokens** (VKBT, CURE) |
| Read mechanism | Graphene transfers / `custom_json` / Power+SMT wraps | Hive-Engine token-transfer ops carried in `custom_json`, replayed by the Engine's sandbox VM into its own state |
| On-chain target | `GrapheneDepositBridge` + `WrappedEcosystemToken` (wMELEK) | **the same** `GrapheneDepositBridge` + `WrappedEcosystemToken` (wVKBT / wCURE) |
| Trust gate | `FederatedBridgeValidatorSet` (BI1) | the same set instance |

Everything below documents only the **Hive-Engine read model**; the deposit/withdraw flow,
K-of-N attester model, distinctness/tuple-agreement on-chain guards, retry/idempotency,
and validator onboarding/rotation are **identical to BI8** and governed by the same
contracts.

---

## 2. The Hive-Engine read model (spec level only)

`steemsmartcontracts` (the engine MELEK-Engine forks) is a **JS-smart-contract sandbox** that
runs on top of a Graphene base chain:

- **Transport.** All Engine operations are posted to the **base chain** as `custom_json`
  ops under the Engine's app id. The base chain is the ordering/data-availability layer; the
  Engine is a deterministic replay of those ops.
- **Execution.** A node runs the Engine VM, replays every `custom_json` op in block order
  through the JS contracts (`tokens`, `nft`, `mining`, etc.), and maintains the resulting
  token-balance state (the reference implementation persists this in a document store; the
  *authoritative* input is the on-chain `custom_json` stream, not the store).
- **A token transfer** is a `tokens` -> `transfer` `custom_json` op: `{ symbol, to, quantity,
  memo }`. To deposit, the user transfers VKBT/CURE to the bridge custody account with the
  destination **PRANA address in the memo** (and optionally the target wrapper id).

### What the watcher must do
1. Follow the base chain's `custom_json` stream filtered to the Engine app id (or run an
   Engine node and follow its derived transfer events — but **verify against the base-chain
   op**, which is the canonical, signed source).
2. Detect confirmed `transfer` ops **to the custody account** for the bridged symbols.
3. Derive the attestation tuple exactly as in BI8:
   - `depositRef` = the base-chain tx id / Engine op sequence (globally unique per deposit),
   - `tokenId` = the registered ecosystem id for that symbol (VKBT → wVKBT, CURE → wCURE),
   - `recipient` = the PRANA address parsed from the **signed memo**,
   - `amount` = the Engine `quantity` scaled to the wrapper decimals (1:1).
4. After the base-chain confirmation/finality wait, call
   `GrapheneDepositBridge.attestDeposit(depositRef, tokenId, recipient, amount)`.

### Read-model caveats (security-relevant)
- **Trust the base-chain op, not the Engine document store.** The signed `custom_json` on
  the base chain is the canonical input; the Engine's persisted balances are a derived view
  and could differ across nodes if a node is buggy/forked. Watchers should reach quorum from
  *independent* derivations of the same base-chain ops — that is exactly what K-of-N gives.
- **Memo is user-signed** → the PRANA destination cannot be forged by the relayer.
- **Symbol → wrapper mapping** must be pre-registered by admin via
  `GrapheneDepositBridge.registerToken(tokenId, wrapped)` (mirroring
  `WrappedTokenFactory.wrappedOf`); unregistered symbols cannot be minted.

---

## 3. Withdrawal flow (wVKBT → VKBT on Hive-Engine)

Identical to BI8 §5: `GrapheneDepositBridge.withdraw(tokenId, amount, destinationRef)` burns
the wrapper and emits `GrapheneWithdrawal`; after a deep PRANA confirmation wait the
federation issues a K-of-N-authorized **Engine `transfer`** of `amount` VKBT/CURE to the
`destinationRef` Hive-Engine account (posted as a `custom_json` op from the custody
account). The PRANA-side `nonce` is the release replay key.

---

## 4. Why this matters (the payoff)

Once VKBT/CURE are ERC-20 (wVKBT/wCURE) on PRANA, the **§3 EVM bridges carry them onward**
to Polygon/Ethereum — so PRANA becomes the **EVM on-ramp for the whole MELEK / SMT /
Hive-Engine asset base**, not just MELEK. The relayer is the seam that turns Graphene-family
tokens into first-class EVM assets.

---

## Cross-references
- `design/bridge/melek-relayer-spec.md` — BI8, the parent spec (read first; shared model).
- `contracts/bridge/GrapheneDepositBridge.sol` — BI7, shared on-chain deposit/withdraw bridge.
- `contracts/bridge/FederatedBridgeValidatorSet.sol` — BI1, the shared K-of-N set.
- `contracts/compute/WrappedEcosystemToken.sol` / `WrappedTokenFactory.sol` — XX1/XX2, the
  minted wrappers and their registry.
