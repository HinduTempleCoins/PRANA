# MELEK → wMELEK relayer + watcher spec (BI8)

> Scope: the **off-chain relayer/watcher** that connects the MELEK chain (a Graphene /
> BLURT-fork social chain, **not** EVM) to PRANA, driving `GrapheneDepositBridge`
> attestations. Spec only — no servers, IPs, credentials, or host content (those are
> excluded by policy and live, if anywhere, in the private vault). This document defines
> the *protocol* a federated relayer follows; each operator runs their own instance.

---

## 1. Why a relayer (and not a light client)

MELEK is a Graphene chain: it has no EVM and no way to produce a proof PRANA can verify
on-chain. So a **federated attester set** stands in for that proof — the same trust model
as `WrappedEcosystemToken` / `PeggedBridgeVault`, hardened from single-custodian to
**K-of-N**. Reference pattern: NutBox's **TSTEEM** relayer (Steem → BSC). The off-chain
relayer watches MELEK, and the **on-chain trust gate is `FederatedBridgeValidatorSet`
(BI1)** queried by `GrapheneDepositBridge` (BI7).

> ⚠️ There is **no on-chain proof** of the MELEK event. A colluding K-of-N could mint
> unbacked wMELEK. K-of-N (vs one custodian) is the only hardening; the audited
> light-client bridge is a later stage and will replace this. See
> `design/bridge/canonical-eth-anchor.md` §4 for the trust-stage ladder.

---

## 2. The contracts this drives (already built)

- **`GrapheneDepositBridge.sol` (BI7)** — `attestDeposit(depositRef, tokenId, recipient, amount)`.
  When K **distinct** active attesters report the **same** `(tokenId, recipient, amount)`
  under a `depositRef`, it mints the registered wrapper to `recipient` **exactly once**
  (`depositProcessed[depositRef]` is the permanent replay guard). `withdraw(tokenId,
  amount, destinationRef)` burns the wrapper and emits `GrapheneWithdrawal` for the release
  leg.
- **`FederatedBridgeValidatorSet.sol` (BI1)** — when wired as the external set, supplies
  `isValidator(addr)` (membership) and the quorum K. Alternatively the bridge runs in
  built-in `ATTESTER_ROLE` + `localQuorum` mode until BI1 is deployed.
- **`WrappedEcosystemToken.sol` (XX1)** — the minted wMELEK ERC-20. The bridge must hold
  its `CUSTODIAN_ROLE`; mint signature is `mint(to, amount, originLockRef)` where
  `originLockRef = depositRef`.
- **`WrappedTokenFactory.sol` (XX2)** — source of the wrapper; its `wrappedOf[originRef]`
  is mirrored by admin into `GrapheneDepositBridge.registerToken(tokenId, wrapped)`.

---

## 3. The K-of-N attester model

- **N attesters**, **K quorum**. Each runs an independent watcher; no attester trusts
  another's report — they each independently observe MELEK and submit their own attestation.
- **Distinctness** is enforced on-chain: `_attested[depositRef][attester]` rejects a second
  attestation from the same key; only **distinct** attesters count toward K.
- **Tuple agreement** is enforced on-chain: the first attestation fixes
  `(tokenId, recipient, amount)` for that `depositRef`; later attesters reporting a
  different tuple are rejected with `AttestationMismatch` (so a dishonest attester cannot
  poison a ref — it just fails to agree and is not tallied).
- **K and membership are DAO-governed** via BI1 (or `ATTESTER_ROLE` admin in built-in
  mode). Rotating/adding/removing an attester takes effect live.

---

## 4. Deposit flow (MELEK → wMELEK on PRANA)

```
 1. User sends N MELEK to the bridge custody account on the MELEK chain
    (a normal Graphene transfer, or a `custom_json` deposit op, or a MELEK-Power /
     MELEK-Engine SMT wrap op).
 2. Each watcher observes the confirmed op and derives:
       depositRef = the MELEK tx id / sequence number   (globally unique per deposit)
       tokenId    = the ecosystem token id (wrapper originRef, e.g. MELEK / a named SMT)
       recipient  = the PRANA address the user encoded in the op memo/json
       amount     = native amount, scaled to the wrapper's decimals (1:1)
 3. After the MELEK-side confirmation/finality wait, each attester calls
       GrapheneDepositBridge.attestDeposit(depositRef, tokenId, recipient, amount)
 4. On the K-th distinct agreeing attestation the bridge mints `amount` wMELEK to
    `recipient` and marks depositRef processed forever.
```

### What the watcher reads on MELEK
- **Plain transfers** to the custody account (amount + memo).
- **`custom_json` deposit ops** — the Graphene mechanism for structured intents; the json
  payload carries the destination PRANA address and (optionally) the target wrapper id.
- **MELEK-Power / MELEK-Engine SMT wraps** — Power and SMT tokens wrap the same way; the
  watcher distinguishes the source asset and maps it to the right `tokenId`.

The **destination PRANA address binding** is the security-critical field: it must come from
the *signed* MELEK op (memo / custom_json), never inferred, so the relayer cannot redirect
funds.

---

## 5. Withdrawal flow (wMELEK → MELEK)

```
 1. User calls GrapheneDepositBridge.withdraw(tokenId, amount, destinationRef)
    on PRANA — the wrapper is pulled in and burned; a GrapheneWithdrawal event fires
    carrying (nonce, tokenId, from, wrapped, amount, destinationRef).
 2. Each attester observes the PRANA-side event (after a DEEP PRANA confirmation wait —
    PRANA is young PoW, so the depth is conservative; see canonical-eth-anchor.md §5).
 3. The federation releases `amount` native MELEK to `destinationRef` on the MELEK chain
    via a K-of-N-authorized custody operation (e.g. a Graphene multisig / threshold
    authority over the custody account).
 4. The PRANA-side `nonce` is the replay key for the release; a release is performed once.
```

`destinationRef` is an opaque encoding of the MELEK-side recipient account, set by the user
in the burn call.

---

## 6. Failure / retry semantics

- **Idempotent submission.** `attestDeposit` reverts `AlreadyAttested` if a watcher resends
  for a ref it already signed, and `DepositAlreadyProcessed` once minted. A watcher may
  therefore **safely retry** — duplicate submissions are no-ops on-chain. The watcher
  should treat "already attested / already processed" as success.
- **Crash recovery.** A watcher recovers purely from chain state: scan MELEK from its last
  durable cursor, and for each candidate deposit check
  `GrapheneDepositBridge.depositStatus(depositRef)` / `hasAttested(ref, me)` before acting.
  No off-chain queue is authoritative; the chain is.
- **Reorg safety.** Never attest before the MELEK-side confirmation/finality threshold.
  If a watched op is reorged out before threshold, it is simply never attested.
- **Partial quorum stall.** If fewer than K attesters are live, the mint waits — funds are
  not lost, only delayed. The DAO can lower K or rotate in healthy attesters via BI1.
- **Mismatch handling.** If watchers disagree on the tuple (e.g. one misreads `amount`),
  the honest majority's tuple is the one fixed by the first attestation; the dissenter's
  `attestDeposit` reverts `AttestationMismatch` and the dissenter must re-derive and resubmit
  the correct tuple. Persistent disagreement is an alerting signal, not a fund risk.
- **Withdrawal release idempotency** is enforced off-chain by keying every release to the
  PRANA `GrapheneWithdrawal` `nonce`; the federation records released nonces durably.

---

## 7. Validator-set onboarding + key rotation (on-chain side = BI1)

- **Onboard** an attester: DAO/timelock calls `FederatedBridgeValidatorSet.addValidator(addr)`
  (N grows, K unchanged), or `grantRole(ATTESTER_ROLE, addr)` in built-in mode. The new
  operator stands up a watcher and begins attesting forward-only (no back-fill of already
  minted refs needed — those are terminal).
- **Rotate** a key: `rotateValidator(oldAddr, newAddr)` atomically swaps the key (N and K
  unchanged). The operator moves their watcher to the new key; in-flight refs they had
  partially attested under the old key remain valid (distinctness is per *current* set
  membership at verify time — operators should avoid rotating mid-attestation of a specific
  ref, or simply re-attest under the new key).
- **Remove / raise K:** `removeValidator` (refuses to drop N below K) and `setThreshold`.
  Lower K before removing if needed.
- All of these are **DAO/timelock-gated** actions; key material and operator infrastructure
  are out of scope for this public spec.

---

## Cross-references
- `contracts/bridge/GrapheneDepositBridge.sol` — BI7, the on-chain deposit/withdraw bridge.
- `contracts/bridge/FederatedBridgeValidatorSet.sol` — BI1, the K-of-N set.
- `contracts/compute/WrappedEcosystemToken.sol` — XX1, the minted wMELEK token.
- `design/bridge/hive-engine-relayer-spec.md` — BI9, the same shape for Hive-Engine tokens.
- `design/bridge/canonical-eth-anchor.md` — BI3, trust-stage ladder + finality policy.
