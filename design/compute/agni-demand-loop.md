# The Agni Demand Loop — closing the compute faucet + sink (AG16)

**Backlog item:** AG16 (Round 9, AI/GridCoin doc §1 + §4).
**Status:** SPEC. The supply and burn primitives are **mostly built**; this doc maps each
piece to its contract, draws the closed loop, and flags the **one missing glue contract**
needed to wire the named loop end-to-end (§5).
**Source threads:** 0xBitcoin / EIP-918 virtual mining (G3 / O33), Factom burn-to-use
(G2 / O32), GridCoin Proof-of-Research (G6), and the compute stack already in
[`contracts/contracts/compute/`](../../contracts/contracts/compute/).

> "Agni" (Sanskrit, *fire*) names the loop: the burn that consumes PRANA on the demand side is
> the same fire that, on the supply side, the chain feeds with fresh emission. Figures are
> illustrative — the DAO sets every rate.

---

## 1. The idea — supply and demand for compute are the SAME token's faucet + sink

A compute network has two halves that usually live in different economies:

- **Supply:** GPUs do useful work (AI inference, scientific compute, GridCoin-style) and must
  be **paid**. That payment is the **faucet** — fresh PRANA emitted to workers.
- **Demand:** users want to *consume* compute (consult Hathor, run premium AI). They must
  **pay** for it. That payment is the **sink** — PRANA removed from circulation.

The Agni design makes both halves the **same token**: PRANA is emitted to suppliers and burned
by consumers. When the two are balanced, the faucet (emission to GPUs) and the sink (burn for
access) net out — the token isn't purely inflationary (workers get paid out of thin air) nor
purely deflationary; **demand for compute directly funds, and offsets, the cost of supplying
it.** That is the whole point of pairing them on one token.

Two complementary burn mechanics drive the demand side, lifted from two precedents:

- **Burn-for-hashrate (0xBitcoin / Bitcoineum virtual mining).** Burn PRANA to claim a
  pro-rata share of a **fixed** per-epoch emission. Fixed emission ÷ rising total burn =
  **falling yield**, so it is **self-balancing**: as more people burn, each unit burned earns
  less, exactly like rising mining difficulty. Competitive, not a guaranteed return.
- **Burn-for-access (Factom usage-burn).** Burn PRANA to *use the service* — consult Hathor,
  buy a window of premium AI access. This is the **exogenous** sink: the token is consumed to
  get a real off-chain good, which makes the burn economy non-circular.

---

## 2. The supply side (faucet) — GPUs earn PRANA. Already built.

The "chain IS the pool" emission rail is the
[`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) (NN1): a
fixed per-epoch PRANA issuance paid pro-rata over a PPLNS window across three lanes. The
**TASK lane** is the GridCoin half — verified AI/useful-work credited as shares:

| Piece | Contract | Role on the supply side |
|---|---|---|
| Canonical pool / emission | [`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) | Fixed per-epoch PRANA issuance → pro-rata payout across HASH / TASK / BURN lanes. |
| AI-work → shares | [`TaskLaneCreditor`](../../contracts/contracts/compute/TaskLaneCreditor.sol) | Credits a *verified* AI task as shares (the GridCoin "useful work" lane). |
| Work verification | [`TaskVerificationGate`](../../contracts/contracts/compute/TaskVerificationGate.sol) | K-of-N quorum (on `AttestationStakeSlash`) — off-chain verification, same trust model as BOINC. |
| Hash heartbeat | [`HashLaneCreditor`](../../contracts/contracts/compute/HashLaneCreditor.sol) | The lightweight-PoW lane (clock/ordering), equal-weighted with TASK by default. |
| Lane weighting | [`HashTaskWeightConfig`](../../contracts/contracts/compute/HashTaskWeightConfig.sol) | DAO-governed hash:task ratio. |

So the faucet — **GridCoin GPUs supply AI → earn PRANA** — exists end-to-end already.

## 3. The demand side (sink) — users burn PRANA. Mostly built.

| Precedent | Piece | Contract | Role on the demand side |
|---|---|---|---|
| 0xBitcoin (G3/O33) | Burn-for-hashrate | [`BurnForHashrate`](../../contracts/contracts/BurnForHashrate.sol) | Burn → pro-rata share of fixed per-epoch emission; **falling yield as total burn rises** (self-balancing). |
| Fixed-ratio mint | Burn-to-mint | [`BurnMine`](../../contracts/contracts/BurnMine.sol) | The simplest sink: burn input at a fixed ratio for output (mesh-able). |
| Factom (G2/O32) | Burn-to-use (per-call) | [`UsageBurn`](../../contracts/contracts/UsageBurn.sol) | Burn PRANA to record a unit of service usage against an off-chain `ref` (e.g. a Hathor query id). |
| Factom (G2/O32) | Burn-for-access (time) | [`AccessGate`](../../contracts/contracts/AccessGate.sol) | Burn PRANA at a fixed price-per-second to extend a time-window of premium access. |
| Cross-currency | Burn router | [`MultiCurrencyBurnRouter`](../../contracts/contracts/compute/MultiCurrencyBurnRouter.sol) | One-click burn of PRANA **or** an allowlisted wrapped ecosystem token; normalizes to weight. |
| Perma-stake | Burn ledger | [`BurnStakeRegistry`](../../contracts/contracts/compute/BurnStakeRegistry.sol) | Records permanent, non-withdrawable burn-weight (the capture-resistant BURN lane). |
| Fee posture | Treasury | [`HathorFeeTreasury`](../../contracts/contracts/compute/HathorFeeTreasury.sol) | Protocol-fee sink that **never trades**; only governance disburses (funds Hathor's own compute). |

So the demand-side burn surfaces (`UsageBurn` for per-call, `AccessGate` for subscriptions,
`MultiCurrencyBurnRouter` for the one-click "Burn Coin Wallet" path) all exist. **GridCoin GPUs
supply AI → earn PRANA; users burn PRANA to consume AI.** Both arrows are present.

---

## 4. The closed loop

```
        ┌──────────────────────── FAUCET (emission) ────────────────────────┐
        │                                                                    │
   fixed per-epoch PRANA issuance                                            │
        │                                                                    │
        ▼                                                                    │
  UnifiedSharesLedger ──TASK lane──▶  GPUs / GridCoin workers  ───────┐      │
        ▲   (TaskLaneCreditor,            (supply AI inference,        │      │
        │    verified by                   scientific compute)         │      │
        │    TaskVerificationGate)                                     │      │
        │                                                              ▼      │
        │                                                      workers earn PRANA
        │                                                              │
        │                                                              ▼
        │                                                   (paid, may re-burn)
        │                                                              │
        └────────── SINK (burn) ◀──── users burn PRANA ◀───────────────┘
                                       to consume AI
                    UsageBurn (per call) / AccessGate (subscription)
                    MultiCurrencyBurnRouter (one-click, any allowlisted token)
                    BurnForHashrate (virtual-mining share, falling yield)
```

The loop: emission pays GPUs for useful AI work (faucet); users pay to consume that AI by
burning PRANA (sink); burned-for-access PRANA can be recycled into the emission budget so the
sink **funds** the faucet rather than the chain printing it from nothing. Burn-for-hashrate's
falling-yield curve keeps the speculative side self-balancing. Same token, both directions.

**The gap in the diagram (today):** the demand-side burns (`UsageBurn`, `AccessGate`) and the
supply-side emission (`UnifiedSharesLedger`) are **not wired to each other**. `UsageBurn`
records a burn and emits `Used(user, amount, ref)` — but nothing (a) tells an off-chain Hathor
service "this user paid, grant the query," and (b) routes that burned value back toward the
emission budget. The faucet and the sink both exist but the **pipe between them is missing**
(§5).

---

## 5. ⚠️ MISSING GLUE CONTRACT — `ComputeAccessMeter` (the AG16 wiring gap)

Everything above is built **except the contract that joins demand to supply**. Concretely,
neither `UsageBurn` nor `AccessGate` does either of the two things the named loop needs:

1. **An entitlement signal an off-chain AI service can key off.** `UsageBurn.use()` emits
   `Used(user, amount, ref)` and `AccessGate` tracks `accessUntil[user]`, but there is **no
   single contract a Hathor gateway can call `isEntitled(user, ref)` / `consume(user)` against
   to confirm "this user has paid for this query / has live premium access."** Hathor (and any
   premium-AI gateway) needs one authoritative read surface, ideally with a per-call
   *consumption* step so a paid credit is spent exactly once (anti-replay), not just an event
   to scrape.
2. **A route from the access-burn back into the emission budget.** The §1 thesis — "demand
   funds supply" — requires the PRANA burned for access to *credit the emission side* (or fund
   `HathorFeeTreasury`, which governance then disburses to compute), instead of just
   vanishing. Today burn-for-access is a dead-end sink; it offsets inflation by removing
   supply, but it does not *fund* the worker faucet, so the loop is open.

**Proposed glue: `ComputeAccessMeter`** (one small contract, composes existing pieces):
- Holds the burn-for-access logic for compute specifically — wrapping/owning a `UsageBurn`
  (per-call) and/or `AccessGate` (time-window) instance, so "burn PRANA → consume AI" has one
  front door (and the Akasha "Burn Coin Wallet" / `MultiCurrencyBurnRouter` can target it).
- Exposes **`isEntitled(account, ref)`** + **`consume(account, ref)`** (role-gated to the
  Hathor gateway) so the off-chain AI service has an authoritative, replay-safe on-chain
  entitlement check — the demand-side analogue of how `TaskVerificationGate` authoritatively
  gates the supply side.
- On each access-burn, **either** routes the value to `HathorFeeTreasury` (governance then
  funds compute — the conservative, no-new-emission-coupling path) **or** signals the
  `UnifiedSharesLedger` to fold it into the per-epoch budget (the tight "demand funds the
  faucet" coupling). Which of the two is itself a parameter/DAO choice — surface it; don't
  hard-wire emission coupling without a decision.

This is the **only** new contract AG16 requires; it is glue, not a new subsystem — every
mechanism it orchestrates (`UsageBurn`, `AccessGate`, `MultiCurrencyBurnRouter`,
`HathorFeeTreasury`, `UnifiedSharesLedger`) already exists and is tested.

---

## 6. Framing discipline — competitive-not-guaranteed + securities posture

This must be described, on-chain and in any UI, as **utility / work**, never as a yield
product. Three load-bearing properties, all already true of the built contracts:

- **Competitive, not guaranteed.** Burn-for-hashrate is *explicitly* a competition for a fixed
  pot: `BurnForHashrate`'s own NatSpec — *"you can get back less than you burned, exactly like
  real miners (so the output must have real utility)."* There is no promised return; rising
  total burn lowers everyone's yield. This is mining economics, not a deposit-for-interest
  product.
- **The burn buys a real good.** Burn-for-access (Factom model) consumes PRANA to *use the AI
  service* — an exogenous utility, not a stake that pays you. `UsageBurn`'s NatSpec: *"the
  token is consumed to use the service, which makes the burn economy real instead of
  circular."* Paying for compute is buying a service, not buying a security.
- **Irreversibility disclosed.** Burns are one-way doors and are documented as such
  (`AccessGate`, `BurnStakeRegistry`, `MultiCurrencyBurnRouter` all disclose irreversibility
  in NatSpec). Users are told the principal is destroyed; no contract implies recoverability or
  return.
- **The treasury never trades.** `HathorFeeTreasury` holds collected value passively and only
  governance disburses it — there is no market-making / profit-seeking surface that would make
  the protocol look like an investment vehicle.

The honest sentence for users: *you burn PRANA to buy compute (a service) or to compete for a
fixed emission share (mining) — you are paying for work and access, not buying a yield-bearing
instrument, and you may receive less than you burned.*

---

## See also

- [`../chain/staked-energy-gas.md`](../chain/staked-energy-gas.md) (AG15) — the *staked* path
  to paying for compute (Energy instead of burn); the demand side's non-burn alternative.
- [`melek-bootstrap-pool.md`](./melek-bootstrap-pool.md) — how the supply-side pool bootstraps
  before PRANA exists.
- [`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) — the
  faucet; [`UsageBurn`](../../contracts/contracts/UsageBurn.sol) /
  [`AccessGate`](../../contracts/contracts/AccessGate.sol) — the sink.
- Research notes G2/O32 (Factom), G3/O33 (0xBitcoin), G6 (GridCoin) — private vault.
