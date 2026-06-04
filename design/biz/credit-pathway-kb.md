# Credit Pathway — Knowledge Base (FF2-2)

> **Public design artifact. General information only — NOT legal, tax, or financial
> advice.** This describes a *generic, publicly-documented* sequence by which a U.S.
> business establishes credit separate from its owner's personal credit. It is the
> grounding corpus for the Business Credit Bot (FF2-1) and the source the FSM (FF2-3) is
> instantiated from. No founder PII. Verify every step against the official source and
> consult a licensed professional before acting.

This document is intentionally deterministic and source-pointing. Each step lists: its
**gate** (what must be true before it), the **official/source** to verify it against, and
its **bot state id** (matching the FSM). Steps marked **PROHIBITED** are things the bot
must refuse.

---

## The core principle: separation

A business builds credit in the **business's own name and identifiers** — its legal entity,
its EIN, its D-U-N-S number — so that the business's creditworthiness is tracked by the
**business** credit bureaus (e.g. Dun & Bradstreet, Experian Business, Equifax Business),
**separately** from the owner's personal consumer credit. The whole pathway is about
building a real, verifiable track record of on-time payment under the business's identity.

> Note: separation is a spectrum, not a switch. Early on, lenders and some vendors may
> still ask for a personal guarantee. The pathway *reduces* personal reliance over time as
> the business's own history grows; it does not promise instant total separation.

---

## Step 0 — `entity-good-standing` (the GATE for everything)

**What:** Form a state-registered legal entity (commonly an LLC, or a corporation /
nonprofit corporation, depending on goals) and keep it in **good standing** with the state.
A business needs to exist as a distinct legal person before it can have its own credit.

**Gate:** none — this is the first step.
**Source / verify:** your state's Secretary of State (or equivalent) business registry;
the entity's formation documents. (See the filing templates, FF2-5, for the *generic*
formation field-schemas.)
**Why it matters:** an unregistered sole proprietorship has no separate legal identity, so
"business credit" collapses back onto the owner. Good standing (reports filed, fees paid)
is what vendors/bureaus check.

---

## Step 1 — `ein` (free, from the IRS)

**What:** Obtain an **Employer Identification Number (EIN)** — the business's federal tax
ID — from the IRS. It is the business analog of an SSN and is used to open bank accounts,
file taxes, and identify the business to bureaus and vendors.

**Gate:** `entity-good-standing` complete.
**Cost:** **free.** The EIN is issued by the IRS at no charge. (See SS-4 template, FF2-5.)
**Source / verify:** IRS (the official EIN application). The bot must point users to the
IRS directly and must **refuse** any "EIN-as-SSN-substitute" framing — an EIN identifies a
*business*, it is not a personal-credit workaround.

---

## Step 2 — `business-bank-account`

**What:** Open a **dedicated business bank account** in the business's legal name using its
EIN. All business income and expenses flow through it.

**Gate:** `ein` complete (banks generally require the EIN + formation docs).
**Source / verify:** the bank directly; the business's formation docs + EIN letter.
**Why it matters:** a separate account is the backbone of separation (commingling personal
and business funds undermines both the legal separation and the credit story) and is a
prerequisite vendors/lenders expect.

---

## Step 3 — `business-presence` (address + listed phone)

**What:** Establish a consistent **business street address** and a **listed business
phone number**, used identically (exact same spelling/format) everywhere the business
appears. Consistency of name/address/phone ("NAP") across records is what bureaus and
vendors match on.

**Gate:** `entity-good-standing` (can run in parallel with banking).
**Source / verify:** the business's own records; directory listings.
**Why it matters:** mismatched or missing contact info causes verification failures and
fragmented credit files.

---

## Step 4 — `duns` (free D-U-N-S number)

**What:** Obtain a **D-U-N-S Number** from Dun & Bradstreet — a unique business identifier
D&B uses to open and track the business's D&B credit file.

**Gate:** `entity-good-standing` + `business-presence`.
**Cost:** **free** to request (D&B offers a no-cost option; expedited/paid options exist
but are not required). The bot must steer to the **free** route and not imply payment is
necessary.
**Source / verify:** Dun & Bradstreet directly.
**Why it matters:** several business-credit scores (e.g. D&B PAYDEX) key off the D-U-N-S
file; vendors that report to D&B need it to attach payment history.

---

## Step 5 — `net30-tradelines` (starter vendor accounts)

**What:** Open **Net-30 vendor (trade) accounts** — accounts where a supplier lets the
business buy now and pay within 30 days — with vendors that **report payment history to the
business bureaus**. Common starter vendors (verify current reporting yourself) include
office/industrial suppliers such as Uline, Quill, and Grainger. The point is to accumulate
several reporting tradelines.

**Gate:** `ein` + `business-bank-account` + `duns` (vendors verify the business).
**Source / verify:** each vendor directly — **always confirm a vendor currently reports,
and to which bureau(s)**, because reporting relationships change. The bot states this as a
*verify-yourself* fact, never a guarantee.
**GUARDRAIL — real tradelines only:** these must be **genuine** accounts where the business
actually buys and pays. The bot must **refuse** "seasoned/rented tradeline" purchases,
authorized-user-for-hire, or any scheme that fabricates history. (See PROHIBITED below.)

---

## Step 6 — `payment-history` (3–6 months on-time)

**What:** Use the tradelines and **pay on time (or early)** consistently, typically for
**3–6 months**, to build a positive reported payment history under the business's
identity.

**Gate:** `net30-tradelines` open.
**Source / verify:** the business bureaus (monitor the business credit file) + each vendor.
**Why it matters:** scores like PAYDEX reward timely (and early) payment; history length +
consistency are what later creditors look at. **There is no legitimate shortcut** — time
and real on-time payments are the mechanism.

---

## Step 7 — `revolving-credit` (store / business cards)

**What:** With a few reporting tradelines and several months of clean history, apply for
**revolving business credit** — store credit cards (tied to the business) and then general
**business credit cards**. Continue paying on time; the file deepens and personal-guarantee
reliance tends to decrease over time.

**Gate:** `payment-history` established.
**Source / verify:** each issuer directly; the business bureaus.
**Why it matters:** revolving accounts broaden the credit mix and the available capital
under the business's name — the maturity end of the generic pathway.

---

## Ongoing — `maintain`

Keep the entity in **good standing** (file periodic reports, pay franchise/registration
fees — see the compliance calendar, FF2-6), keep paying on time, and monitor the business
credit files. Lapses in good standing or late payments damage the file the pathway built.

---

## PROHIBITED (the bot must REFUSE and redirect)

These are flagged `prohibited` so the RAG brain refuses them outright and points back to
the legitimate step. They are associated with **fraud** and the bot does not assist:

- **CPNs (Credit Privacy Numbers)** used as SSN substitutes.
- **Synthetic identities** / fabricated identifiers.
- Using an **EIN as a personal-credit workaround** ("EIN credit, no SSN, no PG, fast").
- **Rented / "seasoned" tradelines**, authorized-user-for-hire, or any purchased history.
- **"Boost-fast"** schemes that fabricate or shortcut real payment history.

**Refusal stance:** "I can't help with that — it's associated with fraud. The legitimate
path is real tradelines you actually use and pay on time. The next legitimate step for you
is <step>." (+ standard disclaimer.)

---

## Deterministic flow (summary)

```
entity-good-standing ──▶ ein ──▶ business-bank-account ──▶ net30-tradelines ──▶ payment-history ──▶ revolving-credit ──▶ maintain
        │                                  ▲                      ▲
        └──▶ business-presence ──▶ duns ───┴──────────────────────┘
```

`entity-good-standing` is the universal gate. `ein` gates banking. `business-presence` +
`entity-good-standing` gate `duns`. `ein` + `business-bank-account` + `duns` gate
`net30-tradelines`. Real on-time `payment-history` gates `revolving-credit`. `maintain`
is ongoing. (This is exactly the FSM in FF2-3.)
