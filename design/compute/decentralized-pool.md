# The Decentralized In-Chain Pool (P2Pool-style, ledger-native)

**Backlog item:** PR6 (`QUEUE-from-docs-8.md` §A).
**Source doc:** "PRANA — The Pool, Hardware Roles & The River" §13 / §14.
**Status:** architecture note (spec/doc). Binds to already-built contracts; no new code here.

> Figures and ratios marked *(as of the doc / approximate)* are taken from the source
> document and are illustrative, not pinned parameters. The DAO sets the real values.

---

## 1. The one-line idea — "the pool is two parts"

PRANA's mining pool is not a company. It is split into two cleanly separable halves
(§13):

1. **The on-chain share-ledger — the canonical source of truth.** A contract that holds
   the per-epoch shares and pays miners directly. This is
   [`UnifiedSharesLedger.sol`](../../contracts/contracts/compute/UnifiedSharesLedger.sol)
   (backlog NN1): one canonical PPLNS pool pinned to the chain, with three lanes (HASH /
   TASK / BURN) crediting into the *same* per-epoch pool and paid pro-rata from a fixed
   per-epoch PRANA issuance over a rolling window. There is exactly one of these, and it
   is the truth everyone settles to.

2. **The off-chain coordinator — a runnable front end that anyone can run.** Software that
   collects work from miners, validates it, batches it, and submits verified shares to the
   ledger. It holds no special authority that a competitor can't also obtain. If a
   coordinator disappears, miners point their workers at a different one and the ledger is
   unchanged — their accrued shares are already on-chain.

The split matters because the *accounting* (who is owed what) lives where it can't be
rugged — on the chain — while the *operational* part (stratum endpoints, share
validation, batching) lives off-chain where it's cheap and anyone can host it.

---

## 2. The Hive / BLURT analogy — many front ends, one chain

On Graphene social chains (Hive, BLURT — the MELEK lineage), the blockchain is the single
source of truth and there are *many* interchangeable front ends reading and writing to it
(condensers, mobile apps, third-party clients). No front end owns the data; if one goes
down you use another and your posts/balances are untouched because they live on-chain.

PRANA's pool applies the same shape to *mining*:

- The **ledger contract** is the chain-of-record (the "Hive blockchain" role).
- A **coordinator** is just one front end among potentially many (the "condenser" role).
- A **worker client** is the user's local agent that talks to whichever coordinator it
  prefers (the "app" role).

Anyone can stand up a coordinator the way anyone can stand up a Hive condenser, and miners
are never locked to one operator.

---

## 3. The P2Pool precedent — and how PRANA does it one better

**P2Pool** (Monero; originally Bitcoin) is the real-world proof that a pool with **no
operator** works. P2Pool's design:

- There is no central pool server holding funds. Miners connect peer-to-peer.
- Shares are tracked on a **separate "sharechain"** — a small, fast side-blockchain that
  exists *only* to record who contributed how much work.
- Payouts are made directly in the main chain's coinbase to each contributing miner
  according to the sharechain — so the pool **never custodies anyone's coins**.

P2Pool's cost is that it needs that **second blockchain (the sharechain)**: extra
software, extra consensus, extra sync, its own orphan/uncle dynamics, and a minimum-effort
floor that makes it awkward for the smallest miners.

**PRANA does it one better: the share-ledger is native to the chain we already own.** We
don't need a separate sharechain because the shares live in a contract *on PRANA itself*.
The chain that issues the reward and the ledger that records the shares are the same
system. So we get P2Pool's no-operator, no-custody property **without** running a second
consensus system beside the main one. (This is the §13/§14 "the chain IS the pool" thesis,
made concrete by NN1.)

---

## 4. The custody-elimination property (for PRANA's own issuance)

The most important consequence: **for PRANA's own native issuance, no coordinator ever
holds miner funds.**

- Payouts come out of a PRANA balance held *inside* the ledger contract and are released
  by `claim(epoch)`, which transfers straight to the claiming miner
  (`UnifiedSharesLedger.claim` → `prana.safeTransfer(msg.sender, paid)`). Even the optional
  fee path routes the fee to the treasury and the net to the claimant inline — a
  coordinator is never in the value path.
- A coordinator's only job is to get *verified shares* recorded. It never receives, holds,
  or forwards the PRANA a miner is owed.

This is the cleanest possible answer to the custody/money-transmitter question for PRANA's
own coin: the contract mints+pays directly, so there is no unlicensed middleman holding
user funds. (The separate question of an off-chain pool mining *external* coins — where
someone *does* custody real ETC/ETHW pre-payout — is handled in
[`custody-guardrails.md`](./custody-guardrails.md). The decentralized model here
**eliminates** that surface for PRANA-native issuance specifically.)

---

## 5. "Open-source three things" — the build implication

To make the pool genuinely permissionless, three components must be open-source so anyone
can self-host the whole stack (§13):

1. **The share-ledger contract** — *done.*
   [`UnifiedSharesLedger.sol`](../../contracts/contracts/compute/UnifiedSharesLedger.sol)
   (NN1), plus the lane creditors
   ([`HashLaneCreditor.sol`](../../contracts/contracts/compute/HashLaneCreditor.sol) NN2,
   [`TaskLaneCreditor.sol`](../../contracts/contracts/compute/TaskLaneCreditor.sol) NN3),
   the permissionless operator gate
   ([`CoordinatorRegistry.sol`](../../contracts/contracts/compute/CoordinatorRegistry.sol)
   PR1), and the dedup arbiter
   ([`JobClaimLedger.sol`](../../contracts/contracts/compute/JobClaimLedger.sol) PR2).

2. **The coordinator** — the runnable off-chain front end (backlog XX18 coordinator
   skeleton; PR8 multi-coin, PR9 vardiff extend it). Collects work, validates it, batches
   verified shares, submits to the ledger lane it's authorized for. Holds no funds.

3. **The worker client** — the miner's local daemon (backlog XX17 worker skeleton). Does
   the actual work (hashing and/or AI tasking), submits to a coordinator of the miner's
   choice, and can re-point to another coordinator at will.

Open-sourcing all three is what turns "the pool" from a service into a protocol.

---

## 6. How verification stops a rogue coordinator from minting fake shares

A permissionless coordinator set is only safe if a malicious coordinator **cannot** invent
shares and credit them to itself. The two lanes defend this differently — and this is the
crux of the whole design:

### HASH lane — self-verifying, no bond needed

A microhash (Ethash-family) share **is its own proof**: it's a nonce whose hash meets the
share difficulty. Anyone can re-check it in milliseconds. There is nothing to lie about
that a bond would deter — a coordinator can't fabricate a valid PoW share any more than a
classic mining pool's customers can. So HASH-lane coordinators are intentionally **not**
required to bond or register (documented directly in `CoordinatorRegistry`'s header: "WHY
HASH NEEDS NO BOND"). Self-verification carries the whole HASH lane.

### TASK lane — rides attestation + stake + slash

A forged "useful-work" (AI/scientific) share is worth a real HASH share in the unified
pool, and useful work is **not** cheaply self-verifiable. So the TASK lane is gated by
economic security, layered:

- **Attestation quorum.**
  [`TaskVerificationGate.sol`](../../contracts/contracts/compute/TaskVerificationGate.sol)
  (NN4) only marks a task claim `isVerified` once **K-of-N** distinct *staked-active*
  attestors attest it. `TaskLaneCreditor` won't mint pooled shares until
  `isVerified() && consume()` succeed, and `consume()` is one-shot so a verdict can be
  credited at most once.
- **Stake at risk + slash.** Attestors must hold stake (the gate reuses
  `AttestationStakeSlash.isActive()` as its gating predicate); a fraudulent attestor is
  slashable out of band. The economic security is composed, not re-implemented.
- **Bonded operator gate.** On top of the per-claim quorum, the *coordinator itself* must
  be a registered, active, unslashed coordinator with at least `minBond` posted in
  [`CoordinatorRegistry.sol`](../../contracts/contracts/compute/CoordinatorRegistry.sol)
  (PR1). The registry is a guard/allowlist, not a forwarder: the audited
  creditor → gate → ledger path is unchanged, and the registry only adds a slashable
  *operator* requirement. Proven fake-work → `slash()` → bond to treasury, coordinator
  terminally inactive.
- **Cross-coordinator dedup.**
  [`JobClaimLedger.sol`](../../contracts/contracts/compute/JobClaimLedger.sol) (PR2)
  ensures the *same* unit of work can't be claimed by coordinator A *and* coordinator B
  for double shares: a job (keyed by `keccak256` of the normalized spec + nonce) is
  `claim`-once chain-wide, with a `release` path so dropped work isn't stranded.

So: a rogue coordinator can't fake HASH shares (math forbids it) and can't profitably fake
TASK shares (it must defeat a staked K-of-N quorum *and* its own bond is slashable *and*
the job can only be counted once).

---

## 7. Open user decision (do not pre-decide)

- **UD-PR-A — coordinator trust model.** Fully permissionless + slashable bond (PR1, true
  Hive/P2Pool decentralization, accepts some spam/Sybil risk) **vs** DAO-vetted
  `*_CREDITOR` role grants (simpler, but "run your own pool" effectively means "be granted
  the role"). The PR1 registry is *built* to support the permissionless path; whether
  production runs it that way or keeps the lane-creditor roles DAO-gated is the user's
  call. See `QUEUE-from-docs-8.md` §"User decisions".

---

## See also

- [`custody-guardrails.md`](./custody-guardrails.md) (PR11) — the external-coin custody
  surface this model eliminates for native issuance.
- [`melek-bootstrap-pool.md`](./melek-bootstrap-pool.md) (PR10) — the pre-PRANA bootstrap
  where the same pool accounting first runs on MELEK-Engine.
- [`hardware-tiers.md`](./hardware-tiers.md) (PR13/PR14) — which hardware feeds which lane.
