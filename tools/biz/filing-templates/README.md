# Filing Templates (FF2-5)

> **Public, generic scaffolds. NOT legal advice. NOT filled forms. No founder PII.**
> Each template is a **field-schema** (JSON) describing the inputs a form needs, plus a
> **guide** (markdown, general/official-instruction-derived). The Business Filing App
> (FF2-4) drives its intake wizard from these schemas and produces a document the **user
> files themselves**. Always verify against the official agency; rules/forms/fees change.

These are parameterized **structures**, never a completed form for any specific entity.

## Templates included

| id | form | jurisdiction | guide | field-schema |
|---|---|---|---|---|
| `ss4-ein` | SS-4 — application for EIN | Federal (IRS) | `ss4-ein.guide.md` | `ss4-ein.fields.json` |
| `form-990` | 990 series — exempt-org annual return | Federal (IRS) | `form-990.guide.md` | `form-990.fields.json` |
| `form-1023` | 1023 / 1023-EZ — 501(c)(3) recognition | Federal (IRS) | `form-1023.guide.md` | `form-1023.fields.json` |
| `tx-llc-formation` | Certificate of Formation — LLC (Form 205) | Texas (SOS) | `tx-llc-formation.guide.md` | `tx-llc-formation.fields.json` |
| `tx-nonprofit-formation` | Certificate of Formation — Nonprofit Corp (Form 202) | Texas (SOS) | `tx-nonprofit-formation.guide.md` | `tx-nonprofit-formation.fields.json` |
| `registered-agent` | Registered-agent designation / consent | Generic (state-parameterized; TX Form 401-A) | `registered-agent.guide.md` | `registered-agent.fields.json` |

## Shared shape

Every `*.fields.json` validates against `intake.schema.json` (the per-jurisdiction template
KB envelope): a `formId`, `jurisdiction`, an ordered `fields[]` array (each with
`name`/`label`/`type`/`required`/`help`/optional `enum`), and a `disclaimer`. The intake
wizard renders the fields; the user supplies values; the app fills the form and hands it
back for the user to file.

## Scope guard (UPL)

The guides give **general information only** — what a field generally means and where the
official instructions live. They never tell a specific user which entity, form, or election
to choose. The user makes every legal choice (see FF2-4 §2).
