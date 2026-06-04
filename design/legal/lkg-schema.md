# Legal Knowledge Graph — node & edge schema (CC2P-1)

_Public design artifact. The companion machine schema is
`tools/legal/schemas/lkg-node-edge.schema.json`. The user-supplied seed taxonomy
that fills the `Category` nodes is PRIVATE — see the gitignored
`tools/brain/state/design/legal/taxonomy-seed.schema.json`._

The Legal Knowledge Graph (LKG) is SoapBox's legal differentiator (doc §7): a
property graph over **public-domain legal authorities** plus the user's own
**case-organizing taxonomy**. Every legal authority is a node; every relationship
(citation, treatment, membership) is an edge. This file defines the abstract,
publishable shape. Nothing founder-specific lives here.

## Design principles

1. **PD-clean only.** Every node carries a `licenseFamily` (`PD` | `gov` |
   `user-original`). Court opinions and US statutes/rules are public-domain or
   government works; legal maxims come from PD dictionaries (e.g. Bouvier's,
   1856); the taxonomy categories are the user's own original
   selection-and-arrangement (Feist-protectable as `user-original`). The LKG never
   holds copyrighted third-party text — it routes through the AA2-4 license-router
   exactly like every other asset.
2. **Probabilistic, never authoritative.** Treatment edges (overrules / follows /
   distinguishes / interprets) are NLP-derived and carry a `confidence`. They
   approximate Shepard's / KeyCite; they are **not** it. Every treatment edge links
   back to the real opinion (`sourceUrl`) and is always surfaced with its
   confidence. A false "good law" signal is dangerous, so the product labels the
   inference and shows the evidence — it never renders a verdict (mirrors the
   AA2-5 "label-the-dispute-never-render-the-verdict" posture).
3. **Deterministic ids.** Node ids are `<type>:<canonical-key>`; edge ids are
   `<type>:<from>-><to>`. Re-ingesting the same authority or relationship dedupes
   rather than duplicating.

## Node types

| Type | What it is | Source corpus (BB2 adapters) | licenseFamily |
|------|-----------|------------------------------|---------------|
| **Case** | A judicial opinion (the precedent unit). | CourtListener, Caselaw Access Project, RECAP | PD |
| **Statute** | A codified law / regulation section (USC, CFR, state code, constitution). | govinfo, usc-uslm, ecfr | gov |
| **CourtRule** | A procedural / evidentiary / appellate / constitutional clause (FRCP, FRE, FRAP, FRCrP, FRBP, constitutional amendments, local rules). | govinfo, usc-uslm | gov |
| **Maxim** | A legal maxim, axiom, or canon of construction. | Bouvier's Law Dictionary (PD), canons-of-construction list | PD |
| **Category** | A node in the user's seed taxonomy — the protectable selection+arrangement layer. First-class graph citizen so any authority can be filtered "by category". | taxonomy-seed (user data) | user-original |

Each node has: `kind:"node"`, `id`, `type`, `label`, `licenseFamily`, optional
`source` / `sourceUrl` / `confidence`, and one type-specific sub-object
(`case` / `statute` / `courtRule` / `maxim` / `category`).

## Edge types

| Type | Direction | Meaning | Polarity |
|------|-----------|---------|----------|
| **cites** | Case → any | Neutral citation harvested from the citation graph. The structural backbone; `confidence` = 1.0. | neutral |
| **follows** | Case → Case | A adopts/applies B as good law. | positive |
| **distinguishes** | Case → Case | A holds B inapplicable on the facts (limits, does not kill). | neutral / limiting |
| **overrules** | Case → Case | A nullifies B as precedent. `subtype` carries overruled / abrogated / superseded-by-statute. | negative |
| **interprets** | Case → Statute/CourtRule/Maxim | A construes the meaning of an authority. | neutral |
| **applies_statute** | Case → Statute | A applies a statute to its facts. | neutral |
| **falls_under** | Case/Statute → Category | Membership in a seed-taxonomy category. | n/a |
| **references** | Case → Maxim | A invokes a maxim/canon. | neutral |

Treatment edges (`follows` / `distinguishes` / `overrules` / `interprets`) carry a
`cue` object — the matched cue phrase, the verbatim surrounding quote, the
character offset, and the polarity — so the inference is always auditable, plus a
mandatory `confidence` and a `sourceUrl` to the establishing paragraph. The
`subtype` field refines the treatment word (e.g. `overrules` →
`superseded-by-statute`).

## How the layers connect

```
Category (user-original taxonomy)
   ▲ falls_under
   │
  Case ──cites──▶ Case ──overrules──▶ Case
   │                │
   │ applies_statute│ interprets / references
   ▼                ▼
Statute          CourtRule / Maxim
```

- The **taxonomy** (Categories) is the entry surface: "show every Case that
  `falls_under` <category> with negative treatment" is the headline query (see
  `graph-db-viz-spec.md`).
- The **citation graph** (`cites`) is harvested structurally from CourtListener
  and is high-confidence.
- The **treatment graph** (`overrules` / `follows` / `distinguishes`) is layered
  on top by NLP cue-phrase detection (see `treatment-detection-spec.md`) and is
  probabilistic.

## Validation

`tools/legal/schemas/lkg-node-edge.schema.json` is a draft-07 schema with a
top-level `oneOf` (a record is either a node or an edge, keyed by `kind`). Validate
each record with any JSON-Schema validator (the repo already uses Ajv in
`tools/brain/state/design/validate-catalog.js`). The ingest pipeline
(`tools/legal/lkg-ingest-skeleton.mjs`) emits records in exactly this shape.
