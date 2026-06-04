# Staked-Energy Gas — the TRX-style resource-gas model for PRANA (AG15)

**Backlog item:** AG15 (Round 9, AI/GridCoin doc §1 + §4).
**Status:** chain-design SPEC + a flagged **USER DECISION** (UD-AG-C). This document presents
a trade-off; it does **not** decide.
**Source threads:** the "staked energy" research note (G13 / O35 — TRON Energy, STEEM
Resource Credits, EtherZero Power) and the existing on-chain resource primitives
[`EnergyGasAccountant`](../../contracts/contracts/EnergyGasAccountant.sol),
[`StakeLock`](../../contracts/contracts/StakeLock.sol),
[`EnergyStamina`](../../contracts/contracts/EnergyStamina.sol).

> Figures are illustrative — every rate / cap / multiplier named here is a parameter the DAO
> sets, not a constant baked into this doc.

---

## 1. What we are lifting from TRON (and what we are NOT)

TRON gives a chain two ways to pay for work:

1. **Burn the coin per transaction** — the Ethereum default. Every tx spends gas, the gas is
   consumed, the user's balance falls. Simple, but every interaction has a direct, visible
   cost, which is the single biggest UX wall for a new user holding a small balance.
2. **Freeze (stake) the coin → receive a regenerating resource → spend the resource instead
   of burning the coin.** TRON calls the two resources **Energy** (for smart-contract
   compute) and **Bandwidth** (for plain transfers / tx size). You stake TRX, you get a
   per-day allowance of Energy/Bandwidth proportional to your stake, you spend that allowance
   on transactions, and **it refills over time for free**. Unstake and the allowance goes
   away; your principal comes back. The coin is never burned for routine activity — it is
   *posted as a bond* that entitles you to throughput.

**What we LIFT:** mechanism #2 — the **resource model**. Stake PRANA → get **Energy** →
spend Energy on transactions *and* on compute (consulting Hathor, AI inference jobs, premium
calls). This is the same idea STEEM ships as **Resource Credits** and EtherZero shipped as
**Power**. It is well-trodden, it is EVM-compatible (it sits *around* the EVM as an accounting
layer; it does not change the EVM itself), and PRANA already has the core primitive built (§3).

**What we DO NOT lift:** TRON's **DPoS consensus** — its 27 elected Super Representatives, its
vote-for-block-producers governance, its validator economics. PRANA's block consensus is
**Ethash PoW** (the deliberate fork choice; see project memory), and governance flows to
**ve-locked / burn-perma stake**, not to a small elected validator set. We want TRON's
*resource-gas ergonomics*, on top of *our own* PoW + stake-weighted governance. The resource
model and the consensus model are separable — TRON happens to ship both; we adopt only the
first.

**The one nuance we keep front-of-mind (the anti-TRON-footgun):** TRON wallets historically
showed Energy/Bandwidth badly, so users hit "out of energy" with no warning and a tx silently
burned TRX instead. The fix is already designed into our primitive: `energyOf(user)` and
`regenRatePerSecond(user)` are **public view functions** so the Akasha wallet can *show* the
live balance and refill rate. (See the NatSpec on `EnergyGasAccountant` — "the anti-TRON-
footgun design.")

---

## 2. The regenerating-resource mechanics (how Energy refills)

The mechanic is **lazy linear regeneration toward a stake-proportional cap** — no keeper, no
cron, no per-block sweep. Everything is computed on read from three stored numbers per account
(`staked`, `energy`, `last`) plus two immutable rates:

- **Cap** `= staked × maxEnergyPerStake`. More stake → bigger ceiling. This is your maximum
  Energy when fully refilled.
- **Regen** `= (now − last) × staked × energyPerStakePerSecond`, clamped to the cap. Energy
  refills continuously and for free at a rate proportional to your stake; it tops out at the
  cap and never exceeds it.
- **Spend** debits Energy; if you don't have enough, the action can't be paid from Energy
  (the caller decides what to do — block, or fall back to burning gas; see §4).

This is exactly what STEEM does with Resource Credits (RC regenerate to full over ~5 days) and
what TRON does with Energy (regenerates to full over 24h). The "refill for free over time"
property is the whole point: an active-but-modest user who stakes once rarely runs dry, so
their transactions feel free and instant after the one-time stake.

**Already implemented**, verbatim from
[`EnergyGasAccountant`](../../contracts/contracts/EnergyGasAccountant.sol):

```solidity
function energyOf(address user) public view returns (uint256) {
    Account memory a = accounts[user];
    if (a.last == 0 || a.staked == 0) return a.energy;
    uint256 regen = ((block.timestamp - a.last) * a.staked * energyPerStakePerSecond) / ACC;
    uint256 cap = _cap(a.staked);
    uint256 e = a.energy + regen;
    return e > cap ? cap : e;          // refill, clamped to the stake-proportional cap
}
```

`stake()` / `unstake()` move the principal and `_settle()` the meter; `spend(amount)` debits
Energy. `regenRatePerSecond(user)` exposes the live refill rate for the wallet UI.

**Two regen *clocks* already exist in the repo, by design:**
- **Seconds** (`EnergyGasAccountant`) — for the gas/resource model, where wall-clock fairness
  is what users feel.
- **Blocks** (`EnergyStamina`) — for games, where deterministic ordering against the chain
  clock matters more than wall-clock. Same lazy-regen-to-cap shape, different unit.

So the regenerating-resource pattern is not hypothetical — it is the repo's house pattern,
used twice already.

---

## 3. How this builds on the existing primitives

This model is **not new construction** — it composes three contracts already in the tree:

| Primitive | Role in the staked-energy gas model |
|---|---|
| [`EnergyGasAccountant`](../../contracts/contracts/EnergyGasAccountant.sol) | **The core meter.** Stake PRANA → regenerating Energy proportional to stake, with a cap; `spend()` debits it; `energyOf` / `regenRatePerSecond` are public for the wallet. This *is* the TRX-Energy accountant. |
| [`StakeLock`](../../contracts/contracts/StakeLock.sol) | **The duration-tier weighting.** Locking for a longer admin-configured tier mints a larger (decaying, soulbound) credit. If the DAO wants "lock longer → more Energy per PRANA," `StakeLock.creditsOf()` is the weighting source; the Energy cap can read from it instead of from raw stake. |
| [`EnergyStamina`](../../contracts/contracts/EnergyStamina.sol) | **The proven regen pattern + optional stake-boost.** Mirrors the lazy-regen design and adds a `setStakeBoost(...)` multiplier sourced from any `balanceOf` contract — the template for "staked PRANA boosts your Energy cap/regen." |

The composition story: `EnergyGasAccountant` is the day-one meter (stake → Energy → spend).
`StakeLock` is the upgrade path if the DAO wants lock-duration to matter (longer lock = more
Energy, same shape as ve-locking). `EnergyStamina`'s stake-boost pattern is how an *external*
staked-balance (e.g. ve-locked PRANA) can multiply your Energy without re-staking into the
accountant. **No new core contract is required to stand up the model** — the meter exists. What
a production rollout needs is the **chain-level plumbing** in §4 (the seam between "I have
Energy" and "this tx pays no gas"), which is a node/protocol concern, not a missing Solidity
contract.

---

## 4. What it changes for every transaction

If PRANA adopts staked-energy gas, the per-tx experience changes for **staked** users:

- **Cheap/fast settlement, no per-tx coin burn.** A user who has staked enough PRANA pays for
  routine transactions and compute calls out of their **regenerating Energy budget**, not by
  burning PRANA each time. After the one-time stake, normal activity feels free — exactly the
  TRON/STEEM "I staked once and now I just use the chain" experience. This is the headline
  on-ramp win: a new holder isn't nickel-and-dimed on every click.
- **Compute and transactions draw from the SAME budget.** Energy pays for ordinary txs *and*
  for compute access (consulting Hathor, an AI-inference call). This is the explicit §4 ask —
  one staked resource covers both "moving value" and "buying compute," which is what makes the
  resource feel like a utility rather than a toll.
- **Spam resistance via the cap, not via fees.** Throughput is bounded by your stake-
  proportional cap and refill rate, so an attacker can't flood the chain without posting (and
  locking) real stake — the same Sybil/spam economics as STEEM RC.
- **Non-staked users are unaffected** — they keep paying ordinary PoW gas in PRANA. Staking is
  opt-in; the Energy lane is a *parallel* payment rail, not a replacement.

**The seam that must be decided (and is NOT a contract):** how a tx whose sender has Energy
actually settles to "no gas burned." Two integration shapes, both standard:
1. **Sponsor/paymaster route (no protocol change).** An ERC-4337 paymaster (PRANA already has
   `VerifyingPaymaster` + the AA stack) checks the sender's `energyOf`, debits via `spend()`,
   and sponsors the gas. Pure contract-level — ships today, no node fork. This is the
   recommended first step and why `EnergyGasAccountant.spend()` is documented as "called by a
   gas-sponsor/relayer integrated with this meter."
2. **Native protocol route (node change).** Bake the Energy check into the node's gas
   accounting (TRON does this at L1). Strongest UX, but it is a **core-geth fork change** to
   the fee mechanism, not a Solidity contract — heavier, needs its own audit, and touches the
   thing we forked Ethereum *to keep compatible*.

---

## 5. ⚠️ USER DECISION — UD-AG-C: TRON-style Energy gas vs native PoW gas

**This is a chain-design choice for the user, presented not decided.**

**Option A — Adopt TRON-style staked-Energy gas (a parallel resource rail).**
- **For:** best-in-class new-user UX (stake once, then "free" txs + compute); strong spam
  resistance tied to real stake; reuses contracts already built; the paymaster route (§4.1)
  ships without forking the node; aligns the gas economy with the staking/governance economy
  (stake gets you throughput *and* a vote).
- **Against / cost:** a second payment rail to reason about, document, and show correctly in
  the wallet (the anti-footgun work is mandatory, not optional); if taken to the *native* L1
  route (§4.2) it is a core-geth fork to the fee mechanism — real audit surface and a
  divergence from stock Ethereum gas semantics; introduces "frozen stake" UX (principal locked
  while you want throughput).

**Option B — Keep native PoW gas only (status quo Ethereum semantics).**
- **For:** maximal compatibility with the entire EVM toolchain we forked Ethereum *for*
  (MetaMask, Remix, audit patterns all assume burn-per-tx gas); nothing new to audit; one
  mental model.
- **Against / cost:** every interaction has a visible cost — the new-user wall stays; no
  stake→throughput alignment; compute access has to be priced some other way (e.g. pure
  burn-for-access, see [`../compute/agni-demand-loop.md`](../compute/agni-demand-loop.md)).

**A pragmatic middle (worth surfacing):** ship Option A **only via the paymaster route**
(§4.1) first — it is additive, reversible, requires no node fork, and reuses the existing
meter + AA stack. Defer the native-L1 route (§4.2) until/unless the resource model proves out.
This gets most of the UX win at the smallest risk. **Still the user's call** — do not treat
the middle path as decided either.

---

## See also

- [`EnergyGasAccountant`](../../contracts/contracts/EnergyGasAccountant.sol) — the core meter.
- [`StakeLock`](../../contracts/contracts/StakeLock.sol),
  [`EnergyStamina`](../../contracts/contracts/EnergyStamina.sol) — the weighting + regen
  patterns this composes.
- [`../compute/agni-demand-loop.md`](../compute/agni-demand-loop.md) (AG16) — the demand side:
  what Energy (or burn) actually *buys* in the compute economy, and how that closes the loop.
- Research note G13 / O35 (private vault) — TRON Energy / STEEM RC / EtherZero Power detail.
