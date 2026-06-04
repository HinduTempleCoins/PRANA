# AI-Music Model Stack (SX1)

> SoapBox Media / Entertainment vertical, Master Build Synthesis §3a. The open,
> self-hostable AI-music stack that lets **Hathor** (the AI Witness) write and sing
> — and that produces a **license-free catalog-fill** layer for the SoapBox media
> catalog.
>
> **PUBLIC FILE.** Public-repo safe: open models, real rulings, and our posture
> only. No founder PII, no server/IP/credentials, no backend/training-infra refs.
> Training infrastructure is named as out-of-scope where it is touched, never
> specified here.
>
> **This spec is the model + legal layer. It does NOT re-derive the corpus rules.**
> The clean-corpus discipline lives in `design/media/ai-music-clean-corpus-note.md`
> (EE2-13); the legal-to-train sources are the SB-E1 audio adapters under
> `tools/adapters/media/`. This spec cross-links those, it does not duplicate them.

---

## 0. Why this exists

SoapBox needs original audio it can host outright: theme music, scoring for the
streaming vertical (`design/media/streaming-service-spec.md`, SX3), bumpers,
Hathor's sung/spoken voice. Buying or licensing a commercial catalog is expensive
and re-introduces exactly the provenance problem the clean-corpus note designs
away. The answer is an **open, local, self-hostable generative-audio stack** that
we control end-to-end, plus a clear **copyright posture** for what comes out of it.

Two outputs, two postures (decided in §2):

- **Pure prompt-only AI output** → no human authorship → **public domain** → a
  *feature*: license-free fill for the catalog, labeled PD.
- **Human-shaped work** (we write lyrics, arrange, edit, perform) → the human
  contribution is protectable → routed to the **creator-chosen license** picker.

---

## 1. The model stack (open, self-hostable)

All entries are chosen for a permissive/open license and the ability to run on our
own hardware (no per-call dependency on a closed API). VRAM figures are indicative
of the published reference configs, not a procurement spec.

### 1a. Song / instrumental generation

| Model | License | What it does | Notes |
| --- | --- | --- | --- |
| **YuE** (`multimodal-art-projection/YuE`) | **Apache-2.0** | Full-song **lyrics → song** (vocals + backing), long-form, multi-genre/multilingual | Reference config is heavy (on the order of **~24 GB VRAM** for the larger stages; quantized/community forks lower this). The anchor "write-and-sing a whole track" model. |
| **ACE-Step 1.5** (`ace-step/ACE-Step`) | Apache-2.0 | Fast foundation music-generation model (text → music, plus editing/inpainting) | Turnkey **local** install; much lighter than YuE; good default for volume catalog-fill. |
| **ACE-Step UI** | open-source UI over ACE-Step | **Spotify-style local web UI** — library, generate, edit, organize | The human-facing surface for the music studio; pairs with ACE-Step as the engine. |
| **DiffRhythm** (`ASLP-lab/DiffRhythm`) | open (Apache-2.0 family) | Fast **full-length** diffusion song generation (lyrics + style → song) | Latent-diffusion; strong speed/length trade-off — alternative engine when ACE-Step's character doesn't fit. |
| **MusicGen** (Meta AudioCraft) | code **MIT**; **weights non-commercial (CC-BY-NC)** for the released checkpoints | Text/melody-conditioned **instrumental** generation | ⚠ The released *weights* are research/non-commercial. Treat MusicGen as a **research-tier engine only**, mirroring the `cc-by-nc` → research-only rule in the clean-corpus note (EE2-13 §2). Use it for prototyping/instrumental sketches, not for catalog-fill we host or monetize, unless run on a model whose weights we are entitled to use commercially. |

### 1b. Voice / TTS / singing voice (Hathor's voice)

| Model | License | What it does | Notes |
| --- | --- | --- | --- |
| **Kokoro** (`hexgrad/Kokoro-82M`) | **Apache-2.0** | Small, fast, high-quality **TTS** | Lightweight default for spoken Hathor lines, narration, bumpers. |
| **XTTS** (Coqui XTTS-v2) | **Coqui Public Model License** (research/non-commercial-leaning; read terms per use) | Multilingual TTS + **voice cloning** | ⚠ License is **not** a blanket commercial grant — gate any commercial use behind a terms check, same discipline as MusicGen. Strong for a consistent cloned Hathor timbre in research/preview builds. |
| **F5-TTS** (`SWivid/F5-TTS`) | code **MIT** (verify checkpoint terms) | Fast, high-fidelity TTS + voice cloning | MIT code path makes it the preferred commercial-leaning TTS where checkpoint terms allow; confirm the specific checkpoint's license before hosting output. |

**The voice-cloning right-of-publicity guardrail.** Cloning a *real person's* voice
implicates right-of-publicity / likeness law independent of copyright. We only ever
clone (a) a synthetic Hathor voice we define, or (b) a voice whose owner has
licensed it to us. This mirrors the `person`/`model-release` flag in the
content-posture spec (`design/soapbox/content-posture-spec.md` §6): a voice clone of
a recognizable person is flagged for an independent rights review, never auto-hosted.

---

## 2. The copyright pivot (the legal core)

### 2a. Pure AI output is not copyrightable — and that is a feature

US copyright requires **human authorship**. The position hardened through 2025:

- **US Copyright Office, *Copyright and Artificial Intelligence*, Part 2: Copyrightability**
  (released **January 2025**): material generated purely from a text prompt, where
  the AI determines the expressive elements, is **not protected by copyright**.
  Prompting alone is not authorship; the human is describing a desired result, not
  fixing the expression. (This follows the Office's 2023 *Zarya of the Dawn*
  cancellation of the AI-generated images and its registration guidance.)
- **Court confirmation, March 2025:** in *Thaler v. Perlmutter*, the **U.S. Court of
  Appeals for the D.C. Circuit** (decided **March 18, 2025**) affirmed that a work
  authored entirely by a machine, with **no human author**, **cannot be registered**
  — the Copyright Act's authorship requirement means a human being.

**Consequence for us:** a track that is **pure prompt-only AI output, with no
meaningful human creative shaping**, carries **no copyright** → it is effectively in
the **public domain**. We treat this as an asset, not a problem:

> Pure-AI tracks become **license-free catalog fill** — host-eligible, labeled
> **PD**, no attribution obligation, no royalty. They flow straight into the HOST
> posture of the content router as a `public-domain` asset.

### 2b. Human-shaped work IS protectable (in its human parts)

The same 2025 guidance is explicit that AI-*assisted* work can be protected **to the
extent of the human's own creative contribution**: human-authored **lyrics**, the
selection/arrangement/coordination of AI-generated material, substantial human
**editing**, a human **performance**, and human-composed structure are protectable
human authorship; the purely machine-generated portions are not. Protection attaches
to the human-shaped layer, disclaimed for the AI layer.

**Consequence for us — the licensing picker.** Every generated work is classified at
creation time and routed to a license:

| Authorship class | Copyright status | License picker outcome | Catalog posture |
| --- | --- | --- | --- |
| **Pure-AI** (prompt-only, no human shaping) | None (PD) | **Labeled Public Domain** — no license needed | HOST as `public-domain` |
| **Human-shaped** (our lyrics / arrangement / editing / performance) | Human parts protectable | **Creator-chosen license** (CC0 / CC-BY / CC-BY-SA / all-rights-reserved) | HOST under the chosen tier, attribution carried if required |

The picker default for *our* human-shaped catalog is **CC0 or CC-BY**, matching the
"our own original output is the anchor tier and should be CC0-dedicated where
possible" rule in the clean-corpus note (EE2-13 §5), so downstream models inherit a
clean, attribution-light base. The picker is the same license-tag mechanism the
content-posture spec already standardizes (`license-tag.schema.json`, AA2-3): a
generated track gets a `license` + `licenseFamily` tag at birth and the
`license-router` (AA2-4) routes it like any other asset.

> **Labeling honesty.** We label pure-AI output **as** PD/AI-generated. We do not
> claim copyright on uncopyrightable output (the Copyright Office warns that a
> registration that fails to disclaim AI material is defective). Honest labeling is
> also what makes the PD-fill defensible.

---

## 3. The real exposure is the TRAINING DATA, not the output

The output-copyright question (§2) is largely settled and in our favor. The live
legal risk in generative music is **what the model was trained on.**

- **The suits:** in **June 2024** the **RIAA** (on behalf of Universal, Sony,
  Warner) sued **Suno** and **Udio** for copyright infringement, alleging the models
  were trained on masses of copyrighted sound recordings without license. These were
  the defining "training data" cases for AI music.
- **The resolution:** the major labels reached **settlements / licensing deals with
  Suno and Udio in late 2025 (around November 2025)** — pairing dollars with
  going-forward licensing rather than a clean court ruling on training-as-fair-use.
  The lesson for anyone *without* a major-label settlement war chest: **do not build
  on a model trained on scraped commercial catalogs.** The unresolved fair-use
  question is a liability we refuse to inherit.

### The clean path (what we actually do)

> **Train / fine-tune ONLY on our own PD + CC catalog → a clean corpus → a clean
> model.** Provenance is the product.

This is exactly the discipline already specified — this spec does not restate the
rules, it points at them:

- **Clean-corpus discipline:** `design/media/ai-music-clean-corpus-note.md`
  (EE2-13) — the tiering rules, the provenance manifest row, the cleared-for gate,
  and the explicit exclusions (no scraped catalogs, no unknown-license stems, no ND,
  no NC in commercial models).
- **The legal-to-train sources (SB-E1 audio adapters)** under
  `tools/adapters/media/`, each surfacing a normalized `license` block the router
  tiers mechanically:
  - `musopen.mjs` — Musopen PD classical recordings + PD sheet music (highest-trust PD).
  - `free-music-archive.mjs` — FMA CC/PD audio.
  - `jamendo.mjs` — Jamendo CC music.
  - `ccmixter.mjs` — ccMixter CC remixes/stems.
  - `freesound.mjs` — Freesound CC sounds/foley.
  - `stock-media.mjs` — additional open/stock media sources.
- **Our own original output** (including the CC0-dedicated human-shaped tracks from
  §2b) is the anchor tier and feeds back into the corpus — a self-reinforcing clean
  base.

The corpus manifest (`{source, id, license, attribution, retrieved_at, cleared_for}`,
EE2-13 §3) makes every training run re-derivable and every input droppable if a
source re-licenses. The training pipeline that consumes the manifest is
**out-of-scope for this public file** (infra), named here only as the consumer.

---

## 4. How a track flows (end to end)

```
                 ┌──────────────────────────────────────────────┐
 clean corpus ──►│ fine-tune (out-of-scope infra) │  EE2-13 manifest gates inputs
 (SB-E1 PD/CC)   └──────────────────┬───────────────────────────┘
                                    ▼
                          clean model (YuE / ACE-Step / DiffRhythm + voice)
                                    │
                    ┌───────────────┴────────────────┐
                    ▼                                 ▼
        prompt-only generation              human-shaped work
        (no human shaping)                  (lyrics / arrange / edit / perform)
                    │                                 │
                    ▼                                 ▼
            §2 classifier ──────────────────► license picker (AA2-3 tag)
                    │                                 │
              PD / labeled AI               creator-chosen (CC0 / CC-BY / …)
                    │                                 │
                    └───────────► license-router (AA2-4) ◄──────────┘
                                          │
                                   HOST  (we serve the bytes — free-to-host)
```

- The classifier decision (pure-AI vs human-shaped) is a creation-time attribute,
  captured in the asset's license tag — not inferred later.
- Both outputs land at **HOST** (we authored/own them and they are free-to-host),
  the host-eligible posture defined in the content-posture spec §1. They never need
  EMBED or AGGREGATE because we are the rights-holder.

---

## 5. Where this plugs into SoapBox

- **Hathor** uses this stack to write (lyrics), compose, and **sing** — her voice is
  the §1b TTS/clone layer over a synthetic-or-licensed Hathor timbre.
- The **streaming vertical** (SX3, `design/media/streaming-service-spec.md`) uses the
  PD/CC output of this stack for scoring, bumpers, and channel music — host-eligible
  audio with zero licensing tail.
- The **content router** (`tools/soapbox/license-router.mjs`, AA2-4) treats generated
  tracks as ordinary tagged assets, so the same HOST/EMBED/AGGREGATE machinery and
  the DMCA §512 / moderation levers apply with no special case.

## 6. See also

- `design/media/ai-music-clean-corpus-note.md` (EE2-13) — the corpus/provenance rules (do not duplicate).
- `tools/adapters/media/{musopen,free-music-archive,jamendo,ccmixter,freesound,stock-media}.mjs` (SB-E1) — the legal-to-train sources.
- `design/soapbox/content-posture-spec.md` (AA2-1) — HOST/EMBED/AGGREGATE + the license-router.
- `tools/soapbox/schemas/license-tag.schema.json` (AA2-3) — the per-asset license tag the picker writes.
- `design/media/streaming-service-spec.md` (SX3) — the video sibling vertical that consumes this audio.
