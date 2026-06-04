# Business Credit Bot — Architecture Spec (FF2-1)

> **Public design artifact.** Generic, jurisdiction-neutral, UPL-safe. Contains NO
> founder PII, NO entity/EIN/501c3/LLC data, NO backend/provider names, NO funds-moving
> logic. Founder-specific data lives ONLY in the gitignored vault
> (`tools/brain/state/design/biz/`) and is OUT-OF-SCOPE for this file.

---

## 0. What this is (and emphatically is not)

The Business Credit Bot is an **educational + progress-tracking assistant**. It explains
the *generic, publicly-documented* pathway by which a U.S. business establishes credit
that is **separate from the owner's personal credit**, and it tracks where a given user is
along that pathway.

| It IS | It is NOT |
|---|---|
| A teaching surface (RAG over a curated, public knowledge base) | A lender, broker, or credit-repair organization |
| A deterministic progress tracker (a finite-state machine) | A system that moves, holds, or routes any money |
| A guide that points to official, free sources (IRS, state SOS, D&B) | A provider of legal, tax, or financial **advice** |
| Generic to any U.S. business | Tied to one person's entities |

**Why it touches no funds — by design.** The bot never custodies, transfers, swaps, or
even reads a user's bank/card balances. By moving no value it sits **outside** the
regulatory perimeter that attaches to trading bots, money transmitters, lenders, and
credit-repair organizations (CROA). It is an information + workflow tool. This is a
deliberate scope boundary, not an incidental one.

**Two hard guardrails baked into the corpus and the FSM:**
1. **Real-history only.** The pathway is *legitimate tradelines + real on-time payment
   history*. The KB and bot **must refuse** to discuss CPNs (credit privacy numbers),
   synthetic identities, EIN-as-SSN-substitute fraud, "seasoned tradeline" rent-a-line
   schemes, or any "boost-fast" trick. These are flagged `prohibited` in the KB and the
   bot returns the refusal + a pointer to the legitimate step.
2. **Not advice.** Every substantive answer carries the disclaimer (§6). The bot states
   general, published facts and process; it never tells a *specific* user what they
   *should* do for *their* situation.

---

## 1. The two-brain architecture (RAG + deterministic FSM)

The bot mirrors the proven shape of the Library-of-Ashurbanipal Discord bot used elsewhere
in the ecosystem: a **retrieval-grounded language brain** for explanation, bolted to a
**deterministic state machine** for "what happens next." The language model **never**
decides progression; the FSM does. The model only *explains* the step the FSM points to.

```
                       ┌──────────────────────────────────────────┐
   user message ─────▶ │  INTAKE / ROUTER (deterministic)          │
                       │  classify: question | progress-update     │
                       │  prohibited-topic guard (refuse + cite)   │
                       └───────────────┬───────────────┬──────────┘
                                       │ question      │ progress-update
                                       ▼               ▼
        ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐
        │  RAG BRAIN  (explains, never decides) │   │  FSM ENGINE  (decides, never      │
        │  retrieve(credit-pathway-kb)          │   │  free-texts)                      │
        │  → grounded answer + citations        │   │  validate prereqs → transition    │
        │  → MUST append disclaimer             │   │  → persist per-user state pointer │
        └───────────────┬──────────────────────┘   └──────────────────┬───────────────┘
                        │                                              │
                        └───────────────┬──────────────────────────────┘
                                        ▼
                          ┌──────────────────────────────┐
                          │  RESPONSE COMPOSER            │
                          │  answer + "you are at: <state>"│
                          │  + next step + disclaimer     │
                          └──────────────────────────────┘
```

### 1a. RAG brain (the explainer)

- **Knowledge base:** `design/biz/credit-pathway-kb.md` (prose) + the structured pathway
  in `tools/biz/.../credit-pathway.kb.json` (see FF2-2). The KB is the ONLY source of
  truth the model may draw substantive claims from. **Grounding is mandatory** —
  closed-book generation about credit/legal/tax topics is disabled.
- **Retrieval:** chunk the KB by step/topic; embed; retrieve top-k for the user's question;
  the model answers **only** from retrieved chunks and cites the step id(s) it used. If
  retrieval returns nothing relevant, the bot says so rather than improvising.
- **Refusal path:** if the question maps to a `prohibited` KB tag (CPN, synthetic ID,
  shortcut schemes), the brain returns the canned refusal and redirects to the legitimate
  step. The model is not free to "be helpful" here.
- **Disclaimer injection:** the composer appends the standard disclaimer to every
  substantive answer. This is a post-process, not something the model can omit.

The language model is a **black box that is never trusted with state, money, or
authority**. Swapping the underlying model changes nothing about the guarantees.

### 1b. FSM engine (the tracker)

- Drives the user through the credit pathway as a finite-state machine: states, gates
  (prerequisites), and forward transitions defined in
  `tools/biz/schemas/credit-bot-fsm.schema.json` (FF2-3) and instantiated from the KB.
- **Deterministic:** given (current state, a validated user-asserted milestone), the next
  state is a pure function. No model in the loop. A user cannot "talk" the FSM into
  skipping a gate; the gate must be satisfied (user attests the prerequisite is true).
- **State is a pointer, not money or PII.** Per-user state = `{ currentState, completed[],
  startedAt, lastUpdated }`. It records *which generic step* the user is on. It does **not**
  store the EIN, bank details, or any document — those stay with the user.
- **Attestation, not verification.** The bot asks "have you completed <prereq>?" and the
  user attests. The bot does NOT log into the IRS/bank/D&B on the user's behalf. (Doing so
  would be account access / a different trust model and is out of scope.)

---

## 2. Data the bot holds vs. data it never touches

| Held (minimal, generic) | NEVER held |
|---|---|
| Current FSM state id | EIN / SSN / TIN |
| List of completed step ids | Bank account / routing numbers |
| Timestamps | Card numbers, balances, statements |
| (optional) a user handle | Any credit report / score data |
| | Personal address / phone (beyond what a user volunteers transiently) |
| | Money, in any form |

The state pointer is intentionally content-free so that the bot stays an *information*
service. If a deployment wants reminders, those key off the FSM state + the
compliance-calendar schema (FF2-6), still without storing the sensitive payloads.

---

## 3. Conversation flows (illustrative, generic)

**A. "How do I start business credit?"** → router: question → RAG retrieves step
`entity-good-standing` + overview → grounded explanation of the generic pathway + "you
appear to be at: not-started; the first gate is a state-registered entity in good
standing" + disclaimer.

**B. "I got my EIN."** → router: progress-update → FSM checks prereq (`entity-good-standing`
completed?) → if yes, transition to `business-bank-account` (EIN is its gate) → persist →
"recorded; next generic step is a dedicated business bank account" + disclaimer.

**C. "Can I use a CPN instead of my SSN to get approved faster?"** → prohibited-topic guard
fires BEFORE retrieval → canned refusal: the bot does not assist with CPNs/synthetic
identities (these are associated with fraud); the legitimate path is real tradelines with
real payment history → pointer to `net30-tradelines` step + disclaimer.

---

## 4. Component inventory

1. **Intake/router** — deterministic classifier (question vs. progress-update) + the
   prohibited-topic guard. No model authority over money or state.
2. **RAG brain** — retriever + grounded generator over the credit-pathway KB; citation +
   mandatory disclaimer.
3. **FSM engine** — loads `credit-bot-fsm.schema.json`, validates prereqs, transitions,
   persists the per-user state pointer.
4. **State store** — minimal pointer store (state id + completed ids + timestamps). No PII,
   no money.
5. **Response composer** — merges answer + "where you are" + next step + disclaimer.
6. **(optional) Reminder hook** — keys off FSM state + compliance calendar (FF2-6); sends
   generic nudges; still touches no funds.

---

## 5. Reuse note

This is the **same RAG-brain + workflow-FSM split** documented for the ecosystem's other
assistants (the Library-of-Ashurbanipal Discord bot pattern, and the analyze/propose vs.
execute split in the DeFAI keeper spec: *reasoning layer proposes, a deterministic layer
bounds/decides, the model never holds authority*). Here the "blast-radius bound" is even
simpler than a vault: **the bot can move nothing at all**, so the worst-case outcome of a
hallucination is a wrong explanation — mitigated by mandatory grounding + citation +
disclaimer — never a financial loss.

---

## 6. Standard disclaimer (appended to every substantive answer)

> **General information only — not legal, tax, or financial advice.** This assistant
> explains a generic, publicly-documented process and tracks your self-reported progress.
> It is not a lawyer, accountant, lender, broker, or credit-repair service, it does not
> handle any money, and it cannot advise on your specific situation. Business-credit rules,
> vendor reporting, and bureau practices change and vary by lender and bureau. Verify every
> step against the official source (e.g. IRS for the EIN, your Secretary of State for entity
> status, the credit bureaus and each vendor directly) and consult a licensed professional
> before making decisions.

---

## 7. Out of scope (named, not built here)

- Any founder-specific entity/EIN/501c3/LLC data ("dogfooding on the founder's stack") —
  PRIVATE, vault only.
- Logging into IRS / banks / bureaus / vendors on a user's behalf (account access ≠ this
  tool's trust model).
- Moving, holding, or routing money; issuing or brokering credit.
- Any backend/provider/aggregator name (deliberately unnamed per scope rules).
