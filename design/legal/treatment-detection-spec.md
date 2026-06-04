# Citation-treatment detection (CC2P-2)

_Public design artifact. Produces the typed, confidence-scored treatment edges
defined in `lkg-schema.md` / `tools/legal/schemas/lkg-node-edge.schema.json`._

## Purpose & the hard constraint

When opinion **A** cites opinion **B**, the bare citation (`cites` edge) is neutral.
The *legal* question is **how** A treated B: did it follow it, distinguish it,
criticize it, or overrule it? Commercial answers to this are Shepard's (LexisNexis)
and KeyCite (Westlaw) — proprietary, paywalled, hand-edited.

This module **approximates** that signal from the **public-domain opinion text** by
parsing cue phrases around each citation, and emits a typed `follows` /
`distinguishes` / `overrules` / `interprets` edge with a **confidence score**.

> **NON-NEGOTIABLE.** The output is PROBABILISTIC and is presented as such — always
> with its confidence and always linked to the actual opinion paragraph. It is
> **never** rendered as an authoritative "good law / bad law" verdict. A false
> "still good law" can sink a real legal position. The UI labels every inferred
> treatment as an inference, shows the matched cue and the surrounding quote, and
> tells the user to read the opinion. This is the AA2-5 posture
> ("label-the-dispute-never-render-the-verdict") applied to precedent.

This is explicitly **not** Shepard's. It is a reading aid over PD text.

## Pipeline (per citing opinion A)

```
opinion A full text (PD)
   │ 1. citation extraction  → list of (citation string, char span) for every cited authority B
   │ 2. window extraction    → for each citation, grab the sentence(s) around it (± N sentences)
   │ 3. cue matching         → scan the window against the cue lexicon (regex/phrase + section/heading signals)
   │ 4. classification       → map matched cues → treatment type + subtype + polarity
   │ 5. confidence scoring   → combine cue strength, proximity, negation, multiplicity
   │ 6. edge emission        → {type, from:A, to:B, subtype, confidence, cue:{phrase,quote,offset,polarity}, sourceUrl}
   ▼
treatment edges (LKG)
```

Citation extraction can be done in two ways and the pipeline uses both:
- **Structural** — CourtListener already returns the citation graph (which B's A
  cites). This gives high-recall, authoritative `cites` edges for free (confidence
  1.0); treatment detection then *upgrades* those neutral edges where cues are found.
- **Textual** — reporter-citation regexes (e.g. `\d+\s+U\.S\.\s+\d+`,
  `\d+\s+F\.(?:2d|3d|4th)\s+\d+`) locate the citation spans inside the opinion text
  so we can read the surrounding cue window.

## Cue-phrase lexicon

The lexicon is a list of `{ phrase, treatment, subtype, polarity, weight }` entries.
`phrase` is matched case-insensitively as a word-boundary pattern; `weight` ∈ (0,1]
is the base strength (how unambiguous the phrase is). The lexicon is data, not code
— ships as `tools/legal/schemas/treatment-cues.json`-style payload inside the ingest
skeleton so it can be tuned without touching logic.

### NEGATIVE — overrules family (kills/erodes B as precedent)

| Cue phrase | subtype | weight |
|------------|---------|--------|
| `we overrule`, `is overruled`, `hereby overrule`, `overruled by` | overruled | 0.97 |
| `we expressly overrule` | overruled | 0.98 |
| `abrogated by`, `we abrogate`, `is abrogated` | abrogated | 0.95 |
| `superseded by statute`, `superseded by rule`, `legislatively overruled` | superseded-by-statute | 0.95 |
| `no longer good law`, `can no longer be reconciled`, `is no longer controlling` | overruled | 0.85 |
| `we disapprove of`, `we reject the reasoning of` | overruled | 0.70 |

### NEGATIVE-soft — criticized / questioned (B weakened, not killed)

| Cue phrase | subtype | weight |
|------------|---------|--------|
| `we criticize`, `has been criticized`, `we are not persuaded by` | criticized | 0.70 |
| `we question`, `casts doubt on`, `we doubt the continuing validity` | questioned | 0.68 |
| `decline to follow`, `we decline to extend`, `refuse to follow` | limited | 0.75 |
| `is limited to its facts`, `we limit <X> to` | limited | 0.72 |

### NEUTRAL/limiting — distinguishes (B inapplicable here, still good law)

| Cue phrase | treatment | weight |
|------------|-----------|--------|
| `is distinguishable`, `we distinguish`, `distinguishable from`, `unlike <X>` | distinguishes | 0.80 |
| `does not control`, `is inapposite`, `is not controlling here` | distinguishes | 0.72 |
| `the facts here differ`, `presents a different question` | distinguishes | 0.60 |

### POSITIVE — follows (B applied as good law)

| Cue phrase | subtype | weight |
|------------|---------|--------|
| `we follow`, `following <X>`, `in accordance with`, `consistent with` | followed | 0.80 |
| `we adopt`, `adopting the reasoning of`, `we agree with` | adopted | 0.78 |
| `we apply`, `applying <X>`, `as <X> instructs`, `controlled by`, `governed by` | applied | 0.80 |
| `reaffirm`, `we reaffirm`, `reaffirming <X>` | followed | 0.85 |

### NEUTRAL — interprets / references (construes an authority or maxim)

| Cue phrase | treatment | weight |
|------------|-----------|--------|
| `we construe`, `interpreting <statute>`, `the statute means`, `gives effect to` | interprets | 0.65 |
| `under the maxim`, `the canon of`, `expressio unius`, `noscitur a sociis`, `ejusdem generis`, `de minimis` | references (Maxim) | 0.70 |

### Structural signals (boost, not phrases)

- A citation that appears in a heading/section literally titled **"Cases Overruled"**
  or in a **disposition** clause (`we reverse`, `we vacate`) near the cite → boost
  the negative reading.
- A **parenthetical** after the cite (`(overruled on other grounds)`,
  `(superseded by statute)`) is a very strong, low-ambiguity signal (weight ≥ 0.9).
- **"on other grounds"** qualifier → cap confidence (the overruling is partial / not
  about the cited holding) and tag `subtype:neutral` where appropriate.

## Confidence model

For a candidate treatment on citation *i* of cited authority B:

```
base        = max weight among cues matched in the window for B          (lexicon strength)
proximity   = 1 / (1 + sentenceDistance(cue, citation))                  (closer cue ⇒ stronger)
negation    = 0.4 if a negation ("not", "cannot", "no longer ... than") flips the cue, else 1.0
parenthetical = 1.10 multiplier if the cue is inside the citation's parenthetical (capped at 1.0)
agreement   = +0.05 per additional independent cue of the SAME polarity (caps at +0.15)
conflict    = 0.6 multiplier if cues of OPPOSING polarity both appear in the window (ambiguous)

confidence  = clamp( base * proximity * negation * parenthetical * agreement * conflict, 0, 1 )
```

- **Structural-only** (`cites` from CourtListener, no cue): confidence `1.0` for the
  neutral `cites` edge; no treatment edge emitted.
- A treatment edge is only emitted above a **floor** (default `0.50`); below the
  floor the relationship stays a plain `cites` edge (we do not guess).
- Confidence is bucketed for display: **high ≥ 0.85**, **medium 0.65–0.85**,
  **low 0.50–0.65**. The UI shows the bucket + the raw score + the cue quote.

## Failure modes the model accepts (and surfaces)

- **String-cite paragraphs** (many citations, one verb): proximity disambiguates,
  but multiple B's may share one cue → emit medium-confidence edges to each, never
  high.
- **"Overruled on other grounds"**: detected and down-weighted; the holding the user
  cares about may be untouched.
- **Implicit overruling** (a later case that silently contradicts B without naming
  it): NOT detectable by cue phrases — out of scope; only the structural citation
  graph + human reading catches it. Documented so the user does not over-trust.
- **Sarcasm / hypotheticals / quotes of a party's argument**: a known false-positive
  source; the surrounding-quote display lets the user catch it.

## Implementation note (skeleton)

`tools/legal/lkg-ingest-skeleton.mjs` ships a **stubbed** `detectTreatment(text,
citations)` that runs the real cue-matching logic against a small built-in lexicon
over fixture text (no heavy NLP deps), and documents the real shape: in production
swap the stub's tokenizer/sentence-splitter for a proper NLP layer (spaCy / a
sentence transformer for the window, plus the eyecite citation extractor) behind the
same function signature. The lexicon and the confidence formula above are the stable
contract; the tokenizer is the replaceable part.
