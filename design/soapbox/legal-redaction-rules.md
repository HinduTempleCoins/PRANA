# SoapBox Legal Redaction Rules (BB2-11)

> **Status:** spec / public-safe. Defines what the legal-data layer (the
> Open States, LegiScan, Congress.gov, and federal court/regulatory adapters in
> `tools/adapters/legal/`) is allowed to surface to end users, what it must
> strip or refuse, and the shape of the redaction pipeline that enforces it.
>
> **Scope:** this is a *publishing-side* safety layer. It sits between the raw
> upstream payloads (which are public-record APIs, but can still echo sensitive
> material) and anything SoapBox displays, indexes, exports to the legal
> knowledge graph, or feeds to a bot. It is deliberately conservative:
> **when in doubt, redact.**
>
> **Non-goals:** this is not legal advice and does not assert what is or is not
> lawfully public in any jurisdiction. It encodes a cautious default posture.
> Jurisdiction-specific carve-outs are governed by the content-posture layer
> (SB-A), not hard-coded here.

---

## 1. Why a redaction layer at all

Government legislative/court/regulatory APIs are *public record* sources, but
"public record" is not the same as "safe to amplify." Three real hazards:

1. **Sealed / restricted material leaks.** Courts seal filings, expunge records,
   and place documents under protective order. Bulk APIs sometimes still expose
   metadata (party names, docket text, attachments) for items that were later
   sealed, or that should never have been indexed. Re-publishing or
   permanently graph-indexing sealed material can cause concrete harm and
   legal exposure.
2. **PII in free-text fields.** Bill text, court docket entries, comment
   submissions (e.g. regulations.gov), and member contact records routinely
   contain incidental personal data: SSNs, dates of birth, home addresses,
   phone numbers, account/financial numbers, medical detail, email addresses
   of private individuals.
3. **Vulnerable persons.** Minors, victims of certain crimes, jurors,
   confidential informants, and protected witnesses appear in records that are
   nominally public. Surfacing or correlating them is a distinct, higher-tier
   harm than ordinary PII.

The redaction layer exists so SoapBox can use these sources for civic
transparency **without** becoming an amplifier or a permanent search index for
the sensitive residue inside them.

---

## 2. The hard rule: NEVER-SURFACE categories

These must never be displayed, indexed, exported, cached to the knowledge
graph, or returned to a bot — full stop. A record matching any of these is
**suppressed** (not merely masked); see pipeline action `SUPPRESS`.

| Category | What it covers | Action |
|---|---|---|
| **Sealed / under-seal** | Items flagged sealed, restricted, or "not available to public" by the source; protective-order docs | SUPPRESS whole record |
| **Expunged / vacated / set-aside** | Records the issuing authority has ordered removed/expunged | SUPPRESS whole record |
| **Juvenile / minor-subject proceedings** | Juvenile justice, dependency, child-welfare, and any record whose primary subject is a minor | SUPPRESS whole record |
| **Sex-offense & abuse victim identity** | Victim names/identifiers in sexual-offense, domestic-violence, child-abuse matters | SUPPRESS the identifying fields; record may survive only fully de-identified |
| **Protected persons** | Jurors, confidential informants, witnesses under protection, undercover identities | SUPPRESS identifying fields |
| **Government-classified / national-security restricted** | Anything marked classified or restricted-distribution | SUPPRESS whole record |
| **Raw government secrets** | Keys, credentials, or non-public security material accidentally present in a payload | SUPPRESS the field |

> If the source's own flags (e.g. a `sealed: true`, `restricted`, `public:false`,
> or an access level) indicate restriction, the record is treated as
> NEVER-SURFACE even if the rest of the payload looks benign.

---

## 3. PII categories (MASK, do not delete the record)

These are masked/tokenized in free-text and structured fields. The surrounding
civic content (the bill, the action, the vote) is preserved; only the personal
identifiers are redacted. Detection is by typed pattern + field-name heuristics;
masking replaces the value with a category token like `[REDACTED:SSN]`.

| Category | Examples | Default treatment |
|---|---|---|
| **Government ID numbers** | SSN, ITIN, passport, driver-license, alien/A-number | MASK (full) |
| **Financial identifiers** | bank account, routing, credit-card, IBAN | MASK (full) |
| **Date of birth** | DOB in any common format | MASK to year-only or `[REDACTED:DOB]` |
| **Residential address** | street address of a private individual | MASK (keep city/state granularity if needed) |
| **Personal phone numbers** | mobile/home numbers of private individuals | MASK |
| **Personal email** | email of private individuals (NOT official `.gov` role inboxes) | MASK |
| **Health / medical detail** | diagnoses, treatment, medical record numbers | MASK |
| **Biometric / precise geolocation** | fingerprints, lat/long tied to a person's home | MASK |
| **Names of private individuals in sensitive context** | private parties incidental to a filing, non-officials | MASK or pseudonymize, context-dependent |

**Explicitly NOT PII to redact (public-official transparency carve-out):**
the identity, party, district, official role, voting record, and official
contact channels of **elected officials and public figures acting in their
official capacity**. The whole point of the legal layer is civic transparency
about lawmakers — their names and votes are kept. (Open States `email` for an
official role inbox is treated as official, not personal.)

---

## 4. Field-level policy by adapter

The masker is field-aware so it does not, e.g., destroy a bill identifier that
happens to look like a number. Per-adapter notes:

- **openstates.mjs (state legislators/bills):** keep `identifier`, `title`,
  `jurisdiction`, `session`, sponsor *official* names, official role, official
  `email`. Run the free-text masker over `title`, `latestActionDescription`,
  and any bill-text body before display. Treat any non-official email/phone in
  a payload as personal → MASK.
- **legiscan.mjs (state legislation):** keep `billNumber`, `title`,
  `description`, `state`, sponsor official names. Mask free-text in
  `description`, `history[].action`, and fetched bill text. Bill text PDFs are
  passed through the same text masker before indexing.
- **congress-gov.mjs (federal bills/members/nominations):** keep member
  `bioguideId`, official name, party, state, district, `latestAction`. Mask
  free-text in titles/descriptions and any nomination `description` that names
  a private nominee's personal data (keep the nominee's name + the office, mask
  DOB/address/etc.).
- **(future) court / docket adapters:** these carry the highest NEVER-SURFACE
  risk. Enforce the seal/expungement check at the record level *before* any
  field is read for display.

---

## 5. The redaction pipeline (shape)

A single, ordered, fail-closed pipeline. Every record from every legal adapter
passes through it before it can be displayed, indexed, exported, or returned to
a bot. The pipeline is **pure and deterministic** (mirrors the adapter-base
philosophy: offline-testable, no hidden network) and emits an **audit record**
of every action it took (category + field + action, never the raw redacted
value).

```
upstream payload (shaped by adapter)
        │
        ▼
 [1] CLASSIFY            ── inspect source restriction flags + record metadata
        │                   → if any NEVER-SURFACE flag/category matches:
        │                        emit SUPPRESS, stop, return null record
        ▼
 [2] DETECT             ── run typed PII detectors + field-name heuristics over
        │                   every string field (and fetched document text)
        ▼
 [3] DECIDE             ── per match: SUPPRESS-FIELD | MASK | KEEP
        │                   (public-official carve-out applied here)
        ▼
 [4] TRANSFORM          ── apply masks/tokens; drop suppressed fields;
        │                   pseudonymize where configured
        ▼
 [5] AUDIT              ── record {recordId, category, field, action} to an
        │                   audit log (values never logged)
        ▼
 [6] EMIT               ── return the redacted record + a redaction summary
                           (counts by category) for the caller/UI
```

**Fail-closed semantics:** if the classifier cannot positively determine that a
record is safe (e.g. unknown access-level value, parse failure, detector
error), it defaults to SUPPRESS rather than emitting. A bug in detection must
never *expose* — only over-redact.

**Idempotent + cache-safe:** redaction runs before anything is written to the
TTL cache or the knowledge graph, so caches and the graph only ever hold
already-redacted data. Raw upstream payloads are never persisted.

**Reversibility:** redaction is one-way for published output. If a record is
later un-sealed by the issuing authority, it is re-fetched fresh — there is no
"un-redact" path over stored data.

---

## 6. Configuration & governance

- **Detector sets and the public-official allowlist are config, not code**, so
  the content-posture governance layer (SB-A) can tune them without a code
  change. Defaults ship conservative.
- **Jurisdiction carve-outs** (some states publish more/less) are expressed as
  config overrides keyed by jurisdiction, layered on top of the global
  NEVER-SURFACE floor. The floor cannot be loosened by a jurisdiction override;
  overrides may only *add* redaction.
- **Human-review queue:** records that the classifier marks ambiguous (matched
  a NEVER-SURFACE heuristic but not a hard flag) are suppressed from automatic
  publication and routed to a manual-review queue rather than shown.

---

## 7. Redaction category quick-reference

**NEVER-SURFACE (suppress):** sealed/under-seal · expunged/vacated · juvenile /
minor-subject · sex-offense & abuse victim identity · protected persons
(jurors / informants / protected witnesses / undercover) · classified /
national-security restricted · raw secrets/credentials.

**MASK (PII):** government ID numbers (SSN/ITIN/passport/DL/A-number) ·
financial identifiers (account/routing/card/IBAN) · date of birth ·
residential address · personal phone · personal email · health/medical detail ·
biometric / precise personal geolocation · private-individual names in
sensitive context.

**KEEP (civic-transparency carve-out):** elected/public officials' identity,
party, district, official role, voting/sponsorship record, and official
(`.gov`/role) contact channels.
