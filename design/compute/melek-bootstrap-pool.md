# MELEK Bootstrap Pool — mining a community + treasury before PRANA exists

**Backlog item:** PR10 (`QUEUE-from-docs-8.md` §C).
**Source doc:** "PRANA — The Pool, Hardware Roles & The River" §7.
**Status:** spec / sequencing note.

> Figures marked *(as of the doc / approximate)* are illustrative; the DAO sets real
> parameters.

---

## 1. The chicken-and-egg problem this solves

PRANA's whole point is a mining pool that pays in native PRANA. But before the PRANA L1 is
live there is no PRANA to pay, and no miners to secure it. You can't bootstrap a mining
economy with a coin that doesn't exist yet.

The §7 answer: **run the pool on MELEK-Engine first, paying a MELEK-Engine token for work
done mining *external* coins.** This builds a real miner community and a real treasury
*before* PRANA exists, then connects to PRANA once it's live. The pool software and the
accounting model are the same ones PRANA will use — only the settlement venue and the
reward token change at first.

---

## 2. The bootstrap sequence (step by step)

**Stage A — pool accounting as an SMT contract on MELEK-Engine.**
MELEK is a Graphene chain with no EVM, but it supports native SMT-style tokens (Smart Media
Tokens — the Steem/Hive-lineage native token layer). Pool accounting (who contributed how
much work this period) runs as an **SMT contract on MELEK-Engine** — the engine being the
token/smart-token layer on MELEK. This is the *same role* the
[`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol) plays on
PRANA: the canonical record of shares. Here it's expressed in MELEK's native token
primitives instead of Solidity.

**Stage B — the off-chain engine mines external Ethash-family EVM coins.**
The off-chain pool coordinator points worker hashpower at established, *external*
Ethash/Etchash-family chains — concretely **Ethereum Classic (ETC)** and **EthereumPoW
(ETHW)** are the named targets (§7/§12). These are live PoW EVM chains that actually pay
block rewards today, so the pool earns real value from day one. (The same coordinator
codebase is what later mines PRANA itself — see
[`decentralized-pool.md`](./decentralized-pool.md) and PR8 multi-coin support.)

**Stage C — rewards distribute in a MELEK-Engine token.**
Work contributed (shares) is paid out in the **MELEK-Engine token**, settled against the
Stage-A SMT accounting. Miners get a tradeable token on a chain that already exists, with a
real community and a real market around it. This is the "real miner community + treasury
BEFORE PRANA exists" milestone.

**Stage D — connect to PRANA; bridge via the wMELEK relayer.**
Once the PRANA L1 is live, the bootstrap pool connects to it:

- New mining flows over to PRANA's own
  [`UnifiedSharesLedger`](../../contracts/contracts/compute/UnifiedSharesLedger.sol)
  (native PRANA issuance, custody-free — see
  [`decentralized-pool.md`](./decentralized-pool.md) §4).
- The MELEK-side value earned during bootstrap reaches PRANA through the **wMELEK relayer**
  path: MELEK tokens are locked on MELEK and a wrapped representation is minted on PRANA.
  The PRANA-side endpoint is the Round-6 **`GrapheneDepositBridge`** (backlog **BI7**),
  which mints wrapped ecosystem tokens (wMELEK / wVKBT) on deposit, paired with the wrapped
  token machinery already built:
  [`WrappedEcosystemToken.sol`](../../contracts/contracts/compute/WrappedEcosystemToken.sol)
  (XX1, lock-mint wMELEK/wVKBT/CURE) and
  [`WrappedTokenFactory.sol`](../../contracts/contracts/compute/WrappedTokenFactory.sol)
  (XX2, per-token wrapped deploy + registry). The off-chain **relayer** watches MELEK
  deposits and drives the PRANA-side mint. (Relayer + bridge specs: Round-6 BI7/BI8 — see
  the Build-Interop batch; cross-link, don't duplicate.)

This is exactly the brief's 3-stage MELEK↔PRANA bridge plan (stage 1: each chain trades its
own; stage 2: wrapped/pegged tokens reach the other chain; stage 3: full audited two-way
bridge last), with the bootstrap pool living in stage 1→2.

---

## 3. The trust / sequencing model

- **Trust during bootstrap = the off-chain pool operator + the MELEK SMT accounting.**
  While mining external coins on MELEK, the pool is a *conventional* (operator-run) pool:
  someone runs the coordinator and the SMT accounting records shares. This is the same
  trust assumption as any classic mining pool, and it is *acceptable for bootstrap* because
  (a) it's temporary, and (b) the accounting is transparent on MELEK. It is **not** the
  trustless end state — that's PRANA's in-chain pool (PR1/PR6).
- **The custody caveat applies here.** Mining real external ETC/ETHW means someone
  custodies real external coins between block-find and payout. That is a regulatory surface
  and is governed by [`custody-guardrails.md`](./custody-guardrails.md) (PR11): mine to
  contract/multisig-controlled addresses, transparent DAO payout, auditable accounting, and
  the integration-not-transmitter rule. The bootstrap stage is precisely the stage where
  those guardrails are load-bearing.
- **Sequencing rationale.** Do the operator-trust, external-coin pool *first* to build
  community + treasury; migrate to the custody-free, permissionless, native-issuance PRANA
  pool *after* PRANA is live. Trust decreases over time as the system moves from "run by an
  operator on MELEK" to "the chain IS the pool" on PRANA.

---

## 4. Why this ordering is the right call

- Users and miners get a **real token to earn now**, not a promise — the hardest part of
  any new pool (attracting hashpower) is solved against established chains that already pay.
- The **same coordinator + worker codebase** is exercised against live coins before PRANA
  depends on it, so PRANA launches into a *proven* pool rather than an untested one.
- A **treasury accrues** during bootstrap (in MELEK-Engine token + whatever external coin
  the DAO retains), funding PRANA's launch.
- It composes with infrastructure already built: wrapped-token contracts (XX1/XX2) and the
  planned GrapheneDepositBridge (BI7) are exactly the rails the bootstrap value travels
  over into PRANA.

---

## See also

- [`decentralized-pool.md`](./decentralized-pool.md) (PR6) — the custody-free end state the
  bootstrap migrates *to*.
- [`custody-guardrails.md`](./custody-guardrails.md) (PR11) — the external-coin custody
  surface that is live during bootstrap.
- Round-6 Build-Interop specs: **BI7** `GrapheneDepositBridge` (wMELEK/wVKBT mint),
  **BI8** relayer — cross-linked, owned in the Build-Interop batch.
- Multi-coin coordinator: PR8 (`QUEUE-from-docs-8.md` §B).
