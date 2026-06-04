# Akasha In-Wallet Bridge-Initiate Spec (AK19 + AK20)

> Public-repo doc. No backend hostnames, IPs, or operator credentials.
> Implementation target: `akasha/lib/bridge-initiate.mjs` (+ test). ethers v6, fixture
> fallback, no new dependencies.

The wallet **initiates** a bridge transfer; it does **not** finalize the other side. The
chain-side bridge contracts are already built (a sibling wave landed them):

- `contracts/contracts/bridge/CanonicalLockMintBridge.sol` — EVM ↔ EVM (PRANA endpoint of a
  K-of-N federated lock/mint bridge).
- `contracts/contracts/bridge/GrapheneDepositBridge.sol` — EVM ↔ Graphene (MELEK / Hive-Engine),
  trusted stage-2 attester federation.
- `contracts/contracts/bridge/FederatedBridgeValidatorSet.sol` (+ `IBridgeValidatorSet.sol`) —
  the K-of-N validator/attester membership + quorum surface both bridges read.

**Core principle:** Akasha only ever signs the one transaction on the chain it controls
(the source chain). Everything that crosses the gap — observing the source event, collecting
K-of-N validator signatures, and producing the mint/release on the destination — is done by an
**off-chain relayer/attester federation** the wallet cannot and does not sign for. The wallet's
job after initiating is to **watch for the completion event** and surface status.

---

## 1. The two routes

### Route A — EVM ↔ EVM (`CanonicalLockMintBridge`)

A wrapped token on PRANA (mintable + burnable, grants the bridge mint rights) that mirrors a
canonical token on some other EVM chain.

| Direction | What the wallet does | Bound function | Completion event (off-chain) |
|---|---|---|---|
| **Withdraw** (PRANA → other EVM) | approve + call `burn` | `burn(uint256 amount, uint256 dstChainId, bytes32 dstAddr) returns (uint256 nonce)` | source-side `Withdrawal(...)`; relayers release on dst |
| **Deposit** (other EVM → PRANA) | lock/burn on the **source** chain (which, if the source is *also* a CanonicalLockMintBridge, is itself a `burn(...)` call there) | source chain's `burn(...)` | PRANA-side `Minted(...)` after K-of-N `mint(...)` |

`burn` emits:

```
Withdrawal(
  uint256 indexed withdrawalNonce,
  address indexed from,
  uint256 indexed dstChainId,
  bytes32 dstAddr,
  uint256 amount
)
```

The inbound completion (which the wallet only **watches**, never signs) is the relayer calling:

```
mint(address to, uint256 amount, uint256 srcChainId, uint256 nonce, bytes[] calldata sigs)
  → emits Minted(address indexed to, uint256 amount, uint256 indexed srcChainId, uint256 indexed nonce)
```

The `sigs` are K-of-N validator signatures over `hashMint(to, amount, srcChainId, nonce)` —
produced entirely off-chain. The wallet never assembles or holds these.

**Pre-step:** the wrapped token is burned via `burnFrom(msg.sender, amount)`, so the wallet must
first `approve(bridge, amount)` on the wrapped ERC-20. `buildWithdraw` returns the approval as a
separate step (the UI shows two signatures: *approve*, then *burn*).

### Route B — EVM ↔ Graphene (`GrapheneDepositBridge`)

PRANA-side wrapped tokens (wMELEK / wVKBT / wCURE) against native balances on a Graphene-family
chain (MELEK) or a Hive-Engine sidechain. Graphene has no EVM, so this side is **asymmetric**.

| Direction | What the wallet does | Bound function | Completion event |
|---|---|---|---|
| **Withdraw** (PRANA → Graphene) | approve + call `withdraw` | `withdraw(bytes32 tokenId, uint256 amount, bytes32 destinationRef) returns (uint256 nonce)` | source-side `GrapheneWithdrawal(...)`; relayer releases native MELEK |
| **Deposit** (Graphene → PRANA) | **no EVM tx** — send native funds on the Graphene chain to the bridge custody account, then watch | none on PRANA from the wallet | PRANA-side `DepositMinted(...)` once K attesters call `attestDeposit(...)` |

`withdraw` emits:

```
GrapheneWithdrawal(
  uint256 indexed nonce,
  bytes32 indexed tokenId,
  address indexed from,
  address wrapped,
  uint256 amount,
  bytes32 destinationRef
)
```

`withdraw` pulls the wrapper in with `safeTransferFrom(msg.sender, bridge, amount)` then burns it,
so — like Route A — the wallet must `approve(bridge, amount)` first.

The Graphene **deposit** completion (watch-only) is:

```
attestDeposit(bytes32 depositRef, bytes32 tokenId, address recipient, uint256 amount)
  → on the K-th distinct attester emits
    DepositMinted(bytes32 indexed depositRef, bytes32 indexed tokenId,
                  address indexed recipient, address wrapped, uint256 amount)
```

`attestDeposit` is called by the attester federation, **not by the wallet**. For a Graphene
deposit the wallet produces no EVM transaction at all: it instructs the user to send native funds
on the Graphene chain (a Graphene-signer concern, out of scope here — see `AK1-3` graphene-signer),
records the expected `(tokenId, recipient, amount)`, and polls for `DepositMinted` by `recipient`.

---

## 2. User flow

```
  pick route + token + amount + destination
            │
            ▼
   ┌──────────────────────────────┐
   │ buildWithdraw / buildDeposit  │  ← lib constructs (and optionally submits) the SOURCE tx
   └──────────────────────────────┘
            │
            ├─ (approval needed?) ── sign approve(bridge, amount)   ← local signature #1
            │
            ▼
        sign the source tx  (burn / withdraw)                       ← local signature #2
            │  emits Withdrawal / GrapheneWithdrawal (carries the nonce)
            ▼
   ┌──────────────────────────────┐
   │ tracking handle {route, dir, │   status: 'initiated'
   │   srcTxHash, nonce, expect…}  │
   └──────────────────────────────┘
            │
            ▼  (OFF-CHAIN, not the wallet)
   relayer observes the source event → collects K-of-N validator sigs →
   submits mint()/attestDeposit() on the destination
            │
            ▼
   ┌──────────────────────────────┐
   │ watchCompletion(handle)       │   status: 'completing' → 'completed' | 'timeout'
   │ (filters Minted / DepositMinted on the DESTINATION provider)
   └──────────────────────────────┘
```

**What is signed locally:** only the source-chain `approve` (if any) and the source-chain
`burn`/`withdraw`. For a Graphene→PRANA deposit, nothing on PRANA is signed — the value movement is
a native Graphene send, and PRANA-side minting is the attester federation's job.

**What the wallet never signs / holds:** validator signatures (the `sigs[]` bundle for `mint`),
the destination `mint`/`attestDeposit` call, attester roles. A compromised wallet cannot forge a
mint — that requires K-of-N validators (federated trust model, documented in the contracts).

---

## 3. Status-tracking model

A bridge transfer is a long, two-phase, partially-off-chain action. The tracking handle is the
durable record the UI renders and the watcher updates.

```js
{
  route: 'evm' | 'graphene',
  direction: 'deposit' | 'withdraw',
  status: 'built' | 'initiated' | 'completing' | 'completed' | 'timeout' | 'failed',
  srcChainId, dstChainId,            // numeric; dst is opaque for graphene-native deposit
  token,                             // wrapped token address (evm) or tokenId bytes32 (graphene)
  amount,                            // bigint
  recipient,                         // destination recipient (address or graphene-encoded ref)
  approval: { needed, txHash } | null,
  srcTxHash: '0x…' | null,           // the burn/withdraw tx (null for graphene-native deposit)
  nonce: bigint | null,              // withdrawalNonce / depositRef — the cross-chain correlation key
  completionEvent: { name, txHash, blockNumber } | null,
  createdAt, updatedAt,
}
```

**State machine:**

- `built` — tx constructed, not submitted (`submit:false`).
- `initiated` — source tx mined; `Withdrawal` / `GrapheneWithdrawal` (or native send) recorded.
- `completing` — watcher started; waiting on the destination event.
- `completed` — destination `Minted` / `DepositMinted` observed and matched.
- `timeout` — watcher hit `timeoutMs` with no match (NOT a failure — bridges can be slow; the
  user can re-arm the watcher or check the explorer).
- `failed` — the source tx reverted, or params were rejected before signing.

**Correlation key.** The watcher matches the completion event to the handle by the
`(srcChainId, nonce)` pair on the EVM route (the `Minted` event indexes `srcChainId` and `nonce`),
and by `recipient` + expected `amount` (and `depositRef` when known) on the Graphene route. The
nonce is **read from the source receipt logs**, not guessed — the lib decodes the
`Withdrawal`/`GrapheneWithdrawal` event from the burn/withdraw receipt and stores it.

---

## 4. Relayer-watch stub (the off-chain piece — STUBBED)

The wallet does not run the relayer; it only **watches the destination for the completion event**.
The real shape of `watchCompletion`:

```
watchCompletion(handle, { dstProvider, timeoutMs, pollMs }) → Promise<handle>
  1. Build an ethers event filter on the DESTINATION bridge:
        EVM:      bridge.filters.Minted(recipient, srcChainId, nonce)
        Graphene: bridge.filters.DepositMinted(null, tokenId, recipient)
  2. Either subscribe (provider.on(filter, …)) or poll getLogs over a moving block window
     until a log matches the correlation key (§3) or timeoutMs elapses.
  3. On match: set status='completed', record completionEvent; resolve.
     On timeout: set status='timeout'; resolve (re-armable).
```

In the skeleton this is **STUBBED**: with a live `dstProvider` it does the real `queryFilter`
poll; without one (fixture mode) it returns the handle unchanged at `status:'completing'` and
documents that production wires a destination provider here. It uses `unref()`-ed timers so it
never holds the process open. **No relayer endpoint, signer, or attester key lives in the wallet.**

---

## 5. Validation (reject bad params before signing)

`buildWithdraw` / `buildDeposit` reject, before any signature:

- zero / non-positive `amount`;
- missing or non-checksummable EVM `recipient` (EVM route) / empty `destinationRef` (graphene);
- unknown route or direction;
- EVM route: missing wrapped-token address or bridge address;
- Graphene route: a `tokenId` that is not a 32-byte hex value;
- a `dstChainId` equal to the source chain (a no-op self-bridge).

---

## 6. Cross-references

- Trust model + exact selectors: the contract NatSpec in `CanonicalLockMintBridge.sol` /
  `GrapheneDepositBridge.sol`.
- Key isolation (the wallet only signs the source tx, keys never leave the signer):
  `design/akasha/signer-boundary-audit-checklist.md` (AK23).
- Cash-out / redemption framing (a bridge withdraw is one rail among the redemption ladder):
  `design/akasha/cashout-rails-spec.md` (AK21).
- Graphene-side signing (native MELEK send for a deposit): the graphene-signer lib (AK1-3).
