# Akasha Cash-Out Rails — Redemption-Ladder Spec (AK21)

> Public-repo doc. No backend hostnames, IPs, operator credentials, or named third-party
> providers. This describes *how the wallet routes a cash-out*, not who operates a rail.
> Not legal advice. Consult counsel before operating any rail that touches fiat.

## 0. Framing: integration, not transmission

Akasha is a **self-custody wallet**. A "cash-out" is the user moving value *out* of self-custody
toward whatever they want next (another chain, a stablecoin, a licensed fiat off-ramp). The
wallet's role is strictly **integration / routing**: it presents the available rails, builds the
on-chain leg the user signs themselves, and hands off to a licensed party for any
fiat/transmission leg. The wallet **never takes custody** of another person's funds and never
performs the fiat transmission itself.

This is the same posture as the compute-side custody note
(`design/compute/custody-guardrails.md`): the dangerous surface is *holding other people's value
pending distribution*. Akasha avoids that surface entirely on the cash-out path — the user holds
their own keys the whole way, and the only party that ever touches fiat is a separately licensed
rail. The wallet is a **routing UI over the user's own signatures**, not a money transmitter.

## 1. The redemption ladder (cheapest / most-self-custodial first)

Rungs are ordered from "stays fully on-chain, no third party" to "exits to fiat through a licensed
party". The wallet always offers the highest rung that satisfies the user's intent.

| Rung | What it is | Custody | Wallet's part | Licensed party needed |
|---|---|---|---|---|
| **1. In-chain swap** | swap to a more-liquid PRANA asset (e.g. a stable) via MELEKSwap | self | builds the swap tx (user signs) | no |
| **2. Bridge out** | move to another chain via the bridge (`bridge-initiate.mjs`) | self | builds the source burn/withdraw (user signs); watches completion | no (federated relayer, not the wallet) |
| **3. On-ramp/off-ramp handoff** | hand the user to a licensed fiat off-ramp with a pre-filled address/amount | self until handoff | builds a deep-link / address+amount payload; **does not** custody | **yes** — the off-ramp is the licensed transmitter |
| **4. P2P / OTC designation** | designate a counterparty payout address (no wallet-mediated settlement) | self | address-book + a signed transfer | depends on counterparty |

Rungs 1–2 are pure self-custody on-chain actions Akasha already builds (`send-flow.mjs`,
`bridge-initiate.mjs`). Rung 3 is the only one that touches fiat, and it is a **handoff**, not a
service the wallet runs.

## 2. Licensed-rail routing (rung 3, the only regulated leg)

When a cash-out needs fiat, the wallet routes to a **licensed rail** and does the minimum:

1. **Eligibility check (client-side):** the wallet may filter the rail list by the user-provided
   region so it only shows rails plausibly available there. This is a UX filter, not KYC, and is
   advisory only.
2. **Build the on-chain leg:** the user signs a normal transfer/withdraw to the address the
   licensed rail provides. The wallet builds it the same way as any send.
3. **Hand off:** open the licensed rail's own flow (its hosted page / app) with a pre-filled
   destination + amount. From there, **KYC, fiat settlement, and transmission are the rail's
   responsibility under its own license.** Akasha holds nothing and settles nothing.
4. **Record a reference:** the wallet stores only a local, user-owned reference (tx hash + the
   rail's returned reference id, if any) for the user's records. No PII is required to live in the
   wallet.

**Hard rule:** Akasha never (a) pools user funds, (b) holds funds pending a payout to a third
party, (c) nets/settles between users, or (d) performs a fiat transfer. Any of those would convert
the integration posture into transmission. The boundary is enforced by *only ever building
transactions the user signs from their own keys, and never having an Akasha-controlled custody
address in the path.*

## 3. What the wallet stores

- The rail catalog (names/types/regions) — static, public data, no secrets.
- Per-cash-out: route taken, on-chain tx hash, optional rail reference id, timestamp — local and
  user-owned (encrypted at rest like the address book, `address-book.mjs`).
- **Never:** user PII for KYC (that lives with the licensed rail), rail API credentials, or any
  custody key for funds in transit.

## 4. Cross-references

- Bridge leg (rung 2): `design/akasha/bridge-initiate-spec.md`, `akasha/lib/bridge-initiate.mjs`.
- Custody / transmitter framing (the same surface, compute side):
  `design/compute/custody-guardrails.md`.
- Key isolation on every signed leg: `design/akasha/signer-boundary-audit-checklist.md`.
- Policy/limits applied before any signature: the wallet-security-spec policy engine (H2).
