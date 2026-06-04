# AI Music — Clean-Corpus Discipline (EE2-13)

> Public-safe note. The rule for any generative-audio work we do: **train and
> fine-tune AI music models ONLY on assets we are legally entitled to use** —
> our own original work plus verified Public-Domain (PD) and openly-licensed
> Creative Commons (CC) material whose terms permit machine learning. No
> scraped commercial catalogs, no "found" stems of unknown origin, no licensed
> music whose license is silent or hostile on AI training.

This is a discipline, not a legal opinion. It exists so the provenance of every
training input is recorded and the output is defensible.

---

## 1. Why a clean corpus

- **Provenance is the product.** A model is only as clean as its inputs. If we
  cannot point to a license for every track that went in, we cannot stand
  behind what comes out. "We don't know where this came from" is the failure
  mode we are designing away.
- **Tiering, not vibes.** Each asset carries a machine-readable license tier
  (see §3). The corpus is assembled from tiers we have explicitly cleared for
  training — never from "probably fine."
- **Reproducible.** Every training run should be re-derivable from a manifest of
  `{source, id, license, attribution, retrieved_at}` rows. If a source later
  revokes or re-licenses an asset, we can find and drop it.

---

## 2. The legal-to-train stack (inventory)

These are the catalogs the media adapters target. Each entry notes the license
tiers it yields and the training posture we take.

| Source | Adapter | Typical license tiers | Train-clean posture |
| --- | --- | --- | --- |
| **Our own assets** | n/a — internal | Owned outright / CC0-dedicated by us | Always in. Highest-trust tier. |
| **Public Domain (expired / dedicated)** | Musopen (PD recordings + sheet), CC0 items across all sources | `public-domain` (PD, CC0) | In. No restrictions; courtesy credit only. |
| **CC0 / CC-BY** | Jamendo, FMA, Freesound, ccMixter, Musopen | `cc-by`, `public-domain` | In, with attribution retained in the manifest. |
| **CC-BY-SA** | Jamendo, FMA, ccMixter | `cc-by-*-sa` | Conditional — ShareAlike may attach to derivatives. Treat as a separate, flagged tier; keep out of the default model unless a ShareAlike release is acceptable for that output. |
| **CC-NC (NonCommercial)** | Jamendo, FMA, Freesound, ccMixter | `cc-by-nc`, `cc-by-nc-sa`, ... | Out of any commercial-output model. May be used only for non-commercial/research builds, clearly labeled. |
| **CC-ND (NoDerivatives)** | any | `*-nd` | Out. Training a generative model is a derivative use; ND forbids it. |
| **Unknown / silent license** | any | `unknown` | Out. No tier, no training. |

The adapters live in `tools/adapters/media/`:
- `jamendo.mjs` — Jamendo CC music
- `free-music-archive.mjs` — FMA CC/PD audio
- `freesound.mjs` — Freesound CC sounds
- `ccmixter.mjs` — ccMixter CC remixes
- `musopen.mjs` — Musopen PD classical + PD sheet music

Each adapter surfaces a normalized `license` block
(`{ name, url, tier, ccVersion, shareAlike, commercialOk, derivativesOk }`) and
an `attribution` block per asset, so the license-router can tier every item
mechanically before it is ever eligible for the corpus.

---

## 3. The provenance rule (operational)

For an asset to enter the training corpus, ALL of the following must hold:

1. **It came through an adapter** (or our own internal pipeline) — never a
   manual paste of unknown origin.
2. **It carries a resolved `license.tier`** that is one of the cleared
   training tiers (`public-domain`, `cc-by`; `cc-by-sa` only into a ShareAlike-
   acceptable build). `unknown` is never cleared.
3. **Its attribution is captured** — `{ source, id, artist/composer, source_url,
   license_url }` — and stored in the run manifest, even when credit is not
   legally required (PD), so the lineage is auditable.
4. **The license permits derivatives and the intended commerciality.** ND ⇒
   excluded. NC ⇒ excluded from commercial-output models.
5. **It is re-checkable.** The manifest row lets us re-fetch and re-verify the
   license later; if a source changes terms, the asset is removed and the model
   is flagged for retraining.

### Corpus manifest row (shape)

```jsonc
{
  "source": "musopen",
  "id": "50271",
  "title": "Symphony No. 5 - I. Allegro con brio",
  "artist": "Ludwig van Beethoven",        // composer/performer for credit
  "license": { "tier": "public-domain", "name": "Public Domain", "url": null },
  "commercialOk": true,
  "derivativesOk": true,
  "shareAlike": false,
  "retrieved_at": "2026-06-04T00:00:00Z",
  "cleared_for": ["commercial", "research"]  // which builds may use it
}
```

The "cleared_for" field is the gate the training pipeline reads: a commercial
build pulls only rows containing `"commercial"`; a research build may also pull
`cc-nc` rows tagged `"research"`.

---

## 4. What this explicitly excludes

- Scraping streaming services, YouTube rips, or any commercial catalog.
- "Stems packs" or sample libraries with no attached, verifiable license.
- CC-ND material (NoDerivatives forbids the derivative use that training is).
- CC-NC material in any model whose outputs we sell or monetize.
- Any asset whose license we cannot resolve to a known tier.

When in doubt, the asset stays out. The cost of a missing track is zero; the
cost of an unclean corpus is the whole model.

---

## 5. Hooks for the rest of the system

- The **license-router** consumes the adapters' `license.tier` and routes each
  asset into the right corpus bucket (PD/BY ⇒ default; SA ⇒ flagged; NC ⇒
  research-only; ND/unknown ⇒ rejected).
- The **catalog merge** (SB-G) should fold the media sources into the shared
  resource catalog with their default license tiers, so the clean-corpus rule
  is enforced at catalog level, not per-run.
- Our **own original output** is the anchor tier and should be CC0-dedicated by
  us where possible, so downstream models inherit a clean, attribution-light
  base.
