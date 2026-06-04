# Business Filing App — Architecture Spec (FF2-4)

> **Public design artifact.** Generic, UPL-safe legal-tech / regtech **document
> automation**. Contains NO founder PII, NO entity/EIN/501c3/LLC data, NO
> backend/aggregator/provider names. Founder-specific filings live ONLY in the gitignored
> vault (`tools/brain/state/design/biz/`) and are OUT-OF-SCOPE here.

---

## 0. What this is: a scrivener, not an attorney

The Business Filing App is a **document-automation** tool. It collects structured user
input through an intake wizard and **fills generic templates / official forms** from that
input — the way a typing service (a "scrivener") fills a form a person dictates. It then
hands the completed document **back to the user to file themselves**.

**The bright line (the "scrivener, not attorney" boundary):**

| Allowed (document service) | NOT allowed (practice of law / UPL) |
|---|---|
| Provide blank/parameterized templates and forms | Tell a *specific* user which form, entity type, or election is *right for them* |
| Fill a form from the user's own typed input | Choose or recommend a legal strategy for the user's situation |
| Offer **general, published** educational information | Give **legal advice** or an **opinion on the user's specific facts** |
| Surface official instructions + official source links | Interpret the law as applied to the user |
| Track deadlines and produce reminders (FF2-6) | Represent the user before any agency or court |
| Let the user review, edit, and file the result **themselves** | File on the user's behalf as their legal agent |

**Framing rule (must appear in product copy):** "This is a self-help document service, not
a law firm; we cannot provide legal advice or apply the law to your situation; the
information is general and you remain responsible for what you file." This is the standard
self-help-legal-software posture. Every output carries the disclaimer (§6).

**Why this boundary keeps the tool UPL-safe:** unauthorized-practice-of-law (UPL) risk
attaches to *advising* a specific person on *their* legal rights/choices. A tool that only
(a) gives general information and (b) mechanically transcribes the user's own input onto a
form does not cross into advice. The app must be engineered so the **user makes every legal
choice** (which entity, which form, which election) and the app merely **records and
formats** it.

---

## 1. The stack (generic, RAG-assisted document automation)

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 1. SCOPE GUARD (deterministic)                                            │
   │    Is this a fill-a-form request, or advice-seeking? Advice → refuse +    │
   │    "general info only; consult a licensed professional."                  │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 2. TEMPLATE KB (per-jurisdiction)                                         │
   │    field-schemas + guides for each form (FF2-5). TX-deep, expandable      │
   │    state-by-state. Generic; no filled forms, no PII.                      │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 3. INTAKE WIZARD                                                          │
   │    walks the form's field-schema; collects the USER's own input;          │
   │    validates types/required/enums. The user makes every legal choice.     │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 4. GENERATE + VALIDATE (RAG-grounded explanation, deterministic fill)     │
   │    fill template from intake; RAG brain explains fields from the guide    │
   │    (general info, cited) but NEVER decides for the user; schema-validate   │
   │    completeness.                                                          │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 5. GENERATE-FOR-USER-TO-FILE                                              │
   │    produce the completed document + a checklist of WHERE/HOW the USER     │
   │    files it with the official agency. The app does NOT submit.            │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 6. COMPLIANCE CALENDAR (the recurring-revenue layer)                      │
   │    from the filing, derive recurring deadlines/fees/reinstatement         │
   │    triggers (FF2-6); remind the user. Touches no money.                   │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 7. DOCUMENT VAULT + ADMIN  (user-owned storage; admin = template mgmt)    │
   └────────────────────────────────────────────────────────────────────────┘
```

The RAG brain follows the same discipline as the Business Credit Bot (FF2-1): **grounded
in the per-jurisdiction guide KB, cites it, appends the disclaimer, and never decides a
legal choice for the user.** Closed-book legal generation is disabled.

---

## 2. UPL-safety mechanisms (engineered, not just disclaimed)

1. **Scope guard up front (§1 step 1):** advice-seeking phrasing ("which entity should I
   pick?", "is an S-corp election right for me?") triggers a refusal-to-advise + a pointer
   to general info + "consult a licensed professional." The app answers *what the options
   generally are*, never *what you should do*.
2. **User-makes-every-choice intake:** entity type, form selection, and elections are
   **user inputs**, never app recommendations. The wizard presents options neutrally with
   general descriptions and links to official instructions.
3. **General-info-only RAG:** field explanations come from the official-instruction-derived
   guide, cited, never an opinion on the user's facts.
4. **Generate-for-user-to-file, never file-for-user:** the app outputs a document + a
   "how/where YOU file" checklist; it does not act as the user's agent before any agency.
5. **Mandatory disclaimer (§6)** on every output and in product copy.
6. **No money, no trust account:** the app never collects state fees or holds client funds
   (see §4) — removing both UPL-adjacent advice risk *and* money-transmitter / trust-
   accounting risk.

---

## 3. Per-jurisdiction template KB

- **Shape:** each form = a JSON **field-schema** (FF2-5) + a markdown **guide** (general,
  official-instruction-derived). TX-deep first, then expandable state-by-state.
- **TX + federal coverage (FF2-5):** SS-4 (EIN), 990 series, 1023 / 1023-EZ, state
  formation (LLC / nonprofit corporation), periodic/annual reports, franchise-tax / TX
  Public Information Report (PIR), registered-agent designation, foreign qualification,
  reinstatement, DBA / assumed name.
- **Generic only:** field *schemas* and *guides*, never a filled form and never founder
  data.

---

## 4. Hard-parts register (the real difficulties — named, not solved)

These are flagged for the user/operator as genuine product+legal hazards; the app's design
*avoids* them rather than pretending they are easy:

1. **The UPL line.** The single biggest risk. Mitigation = the entire §2 mechanism set; if
   in doubt, the app gives general info + "consult a licensed professional," never advice.
2. **E-filing fragmentation.** Every agency (IRS, each state SOS, each county for DBA) has
   its own portal/format/rules. The app's stance is **generate-for-user-to-file** — it does
   NOT integrate live e-filing submission (that is out of scope, named below). This sidesteps
   the fragmentation entirely.
3. **50-state variance.** Forms, fees, deadlines, and entity rules differ per state. The
   template KB is structured per-jurisdiction (TX-deep, expandable); never assume one
   state's rule applies to another.
4. **Registered-agent physical presence.** Most states require a registered agent with a
   physical in-state address. The app can produce the *designation form* but **cannot be**
   the registered agent (that is a live physical-presence service — out of scope).
5. **Entity-tax liability.** Entity choice carries tax consequences. The app explains
   options generally and **defers to a licensed professional** — it does not advise on tax.
6. **User-pays-state-directly / trust-accounting.** The app NEVER collects state fees or
   holds client money. The user pays each agency directly. This removes client-trust-account
   / money-transmitter obligations by design.
7. **BOI / FinCEN note.** Beneficial-ownership-information reporting under the Corporate
   Transparency Act has shifted: per the FinCEN interim final rule (March 2025), **domestic
   U.S. companies were exempted** from the BOI reporting requirement (reporting refocused on
   certain foreign entities). The guide must present this as *general, time-sensitive
   information to verify against current FinCEN guidance* — rules here are volatile.

---

## 5. Component inventory

1. **Scope guard** — deterministic advice-vs-fill classifier + refusal-to-advise.
2. **Template KB** — per-jurisdiction field-schemas + guides (FF2-5).
3. **Intake wizard** — schema-driven; user makes every legal choice; validates input.
4. **Generate + validate** — deterministic fill + RAG-grounded general explanation + schema
   completeness check.
5. **Generate-for-user-to-file** — completed document + "how/where YOU file" checklist.
6. **Compliance calendar** — recurring deadlines/fees/reinstatement triggers (FF2-6); the
   recurring-revenue layer; reminders only, no funds.
7. **Document vault + admin** — user-owned document storage; admin = template/version
   management.

---

## 6. Standard disclaimer (on every output + product copy)

> **Self-help document service — NOT a law firm and NOT legal or tax advice.** This tool
> provides general information and fills forms from the information YOU provide. It does not
> select forms or strategies for you, does not apply the law to your situation, does not
> file on your behalf, and does not collect government fees or hold your money. Laws, forms,
> fees, and deadlines change and vary by jurisdiction — verify everything against the
> official agency (e.g. the IRS, your Secretary of State, FinCEN) and consult a licensed
> attorney or accountant before filing.

---

## 7. Out of scope (named, NOT built here)

- The founder's own entity/EIN/501c3/LLC filings ("dogfood on the founder's stack") —
  PRIVATE, vault only.
- **Live e-filing submission** to any agency; **filing-aggregator API** accounts (no
  provider named).
- Acting as a **registered agent** (physical in-state presence).
- Collecting/holding **state fees or client money**; any trust accounting.
- Giving **legal or tax advice** or representing a user before an agency.
- Any **backend/provider/aggregator name** (deliberately unnamed per scope rules).
