# Health Guardrails — Entrainment / Bio Vertical (BI16, LOAD-BEARING)

> **This document is load-bearing. It overrides the entrainment spec on any safety or
> claims question.** If anything in `entrainment-spec.md`, the contract, the app, or
> marketing conflicts with this file, this file wins. Nothing here is legal or medical
> advice; before launch the relevant language and limits must be reviewed by qualified
> counsel for the operating jurisdiction(s).

The Bio vertical lets creators publish and sell **entrainment programs** (paced audio/
visual content). Audio/visual entrainment is a wellness/relaxation and entertainment
category — **not** a diagnosed, treated, cured, or prevented medical intervention. The
guardrails below exist so the product stays honest and safe and does not drift into
unlicensed medical claims.

---

## 1. Core stance — sober and honest

- **No therapeutic claims, anywhere.** Not in program names, not in `doseURI` content,
  not in app copy, not in marketing. Do not state or imply that a program treats, cures,
  heals, diagnoses, prevents, or mitigates any disease, disorder, or symptom (e.g.
  depression, anxiety disorder, insomnia as a diagnosed condition, ADHD, pain, addiction,
  PTSD, etc.).
- **Wellness/entertainment framing only.** Acceptable framing is experiential and
  non-clinical: "relaxation", "focus session", "wind-down", "ambient sound experience".
  Avoid clinical/medical verbs and outcome promises.
- **No efficacy guarantees.** The evidence base for "brainwave entrainment" producing
  specific cognitive or clinical outcomes is limited and mixed. Do not present effects as
  established fact. If describing intended *experience*, hedge it ("designed to feel
  calming", not "will reduce your anxiety").
- **Honesty about what the chain stores.** On-chain we store only a content hash, a URI,
  a price, and a license token. The chain asserts nothing about health.

---

## 2. Required disclaimer block (must be shown, off-chain)

The app/player MUST surface a disclaimer before a dose can start, and `doseURI` content
MUST include it. Minimum content:

> This content is for relaxation and entertainment only. It is not medical advice and is
> not intended to diagnose, treat, cure, or prevent any disease or health condition. It is
> not a substitute for professional medical care. Consult a qualified healthcare provider
> before use if you have any medical condition. Stop immediately if you feel unwell.

The disclaimer is a **gate**, not fine print: the player should require explicit
acknowledgement before first play and surface contraindications (Section 3) at the same
point.

---

## 3. Safety contraindications (must be presented before use)

Users MUST be warned, and advised not to use programs (or to consult a clinician first),
in at least the following situations:

- **Photosensitive epilepsy / seizure history** — any flashing, strobing, or rapid visual
  pattern can trigger seizures in susceptible individuals. Programs with a visual/flicker
  component MUST carry a prominent photosensitivity warning. When in doubt, default to
  audio-only or cap flicker rates conservatively.
- **Epilepsy or seizure disorders generally** — advise caution / clinician consult even for
  audio-only programs.
- **Pacemakers or other implanted medical devices.**
- **Pregnancy.**
- **Children** — not designed for or directed at minors without adult supervision; keep the
  product out of child-directed framing.
- **While driving or operating machinery** — programs may induce drowsiness or altered
  attention; never to be used while driving or in any safety-critical task.
- **Mental-health conditions** — advise users under care for any psychiatric condition to
  consult their provider first; do not position programs as a substitute for treatment.
- **Headphone volume / hearing** — warn against excessive volume; recommend moderate levels.

The app SHOULD let users dismiss these only after an explicit acknowledgement, and SHOULD
re-show the photosensitivity warning for any program flagged with a visual component.

---

## 4. Creator obligations (publishing-side rules)

Creators publishing via `EntrainmentProgramNFT` MUST:
- include the disclaimer block and applicable contraindications in the `doseURI` bundle;
- flag any visual/flicker component honestly so the photosensitivity warning is shown;
- NOT use therapeutic/medical claims in the program `name` or content;
- NOT target minors or vulnerable groups;
- keep `programHash` consistent with the published bundle (integrity).

The marketplace front-end SHOULD enforce these at publish time (refuse obvious medical-
claim names, require the disclaimer flag) and reserve the right to delist non-compliant
programs. The contract itself does not and cannot police content — enforcement is an
off-chain / front-end / governance responsibility. (See Marketplace trust-tiers, BI19.)

---

## 5. What the contract does NOT do (by design)

- It stores **no** health claims and renders **no** medical judgement.
- It does **not** verify content safety — `programHash`/`doseURI` are opaque to it.
- It does **not** gate by age, jurisdiction, or medical status — those gates live in the
  app/front-end, which is where the disclaimers and acknowledgements are enforced.

This separation is deliberate: the chain is a neutral licensing + payment rail; the
safety surface is the application layer, governed by this document.

---

## 6. Regulatory caution (non-exhaustive, not legal advice)

Health-adjacent claims can bring a product under medical-device, drug, advertising, or
consumer-protection regimes (e.g. FDA in the US, MHRA/UKCA, EU MDR, and various
advertising-standards bodies). The single most effective way to stay clear of these is the
Section 1 stance: **make no therapeutic claims and frame strictly as wellness/
entertainment.** Obtain jurisdiction-specific legal review before any launch or paid
distribution, and re-review whenever copy, framing, or features change.

---

## 7. Review triggers

Re-review this document and the surfaced copy whenever:
- a new program category or a visual/flicker feature is added,
- marketing or app copy changes,
- entering a new jurisdiction,
- any user-safety incident or complaint is reported.
```
