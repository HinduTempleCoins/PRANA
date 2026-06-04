# Data-Spine Ingest Spec — the §9-step-1 three-tier engine (HH2-2)

> SoapBox / Data.SoapBox. Maps the master-build-synthesis **§9 step 1 & 7** ingest
> spine: every asset that enters SoapBox is license-tagged, routed to a serving
> **tier** by the SB-A license-router, and stamped with a **provenance chain** that
> feeds the transparency-score the live site already shows.
>
> **PUBLIC FILE.** Generic ingest/licensing architecture only. No founder PII, no
> server/IP/credentials, no live-pinning or e-filing infra. Those pieces are named
> as out-of-scope where the spine touches them, never specified here.

---

## 0. Where this sits

This is the cross-cutting **spine** under every SoapBox vertical (Law.SoapBox,
Library vertical, Media catalog, Data.SoapBox). Each vertical's read-only adapter
pulls records; the spine is the single path those records take from "raw upstream
JSON" to "a record SoapBox may serve, and at what posture."

```
upstream API ──► adapter (read-only) ──► [DATA SPINE] ──► surface (HOST / EMBED / AGGREGATE)
  (tools/adapters/legal|library|media/*.mjs)        │
                                                     ├─ 1. license-tag    (AA2-3 schema)
                                                     ├─ 2. tier-route     (AA2-4 router)
                                                     ├─ 3. provenance-stamp
                                                     └─ 4. transparency-score input
```

The spine is **deterministic and pure where it can be**: tagging is data-driven,
routing is the pure `license-router` function, provenance is append-only metadata.
No bytes are copied, pinned, or hosted by this spec — it produces a *record* that a
later (out-of-scope) hosting layer may act on.

**Wiring order (master-build-synthesis §9): open / no-key adapters first.** The
spine onboards sources in this priority so the catalog is useful before any key is
provisioned:

1. **No-key, open-license** (HOST-eligible): Gutendex, Internet Archive, Open
   Library, Wayback, Musopen, ccMixter, Free Music Archive, CourtListener, RECAP,
   Caselaw Access, US Code/eCFR/Federal Register, OpenAlex, Crossref, World Bank,
   NWS/NOAA, Open-Meteo, Wikimedia Commons.
2. **Free-key, open-license** (HOST/AGGREGATE): GovInfo, Open States, LegiScan,
   Congress.gov, Jamendo, Freesound, FRED, BLS, Census, EIA, USDA NASS, Podcast
   Index.
3. **Metadata-only / discovery** (AGGREGATE): TMDB, Watchmode, Trakt, OMDb, Simkl,
   Radio Browser, Listen Notes, iTunes Search, GDELT, Unpaywall.
4. **Official-player embeds** (EMBED): Dailymotion, Vimeo, Windy Webcams (YouTube
   handled by the embed-whitelist player, EE2-11/EE2-12).

Each catalog entry in `tools/brain/state/design/vkfri-resource-catalog.json` (private)
already carries the
`{license, tier, keyRequired, openAccess}` tags this ordering reads (GG2).

---

## 1. Step 1 — license-tag (AA2-3)

Every ingested record is normalized to a **license tag** conforming to
`tools/soapbox/schemas/license-tag.schema.json`:

```
{ license, licenseFamily, copyrightStatus?, source, sourceLicensed,
  tier?, attribution?, flags[], provenance?, confidence? }
```

- `licenseFamily` ∈ `PD | CC0 | CC-BY | CC-BY-SA | CC-NC | gov | user-original |
  copyrighted-3p | unknown` — the normalized field the router branches on.
- The adapter supplies what the upstream publishes (`license`, `source`); a
  **per-adapter tag-mapper** normalizes that to `licenseFamily` + `sourceLicensed`.
  Example mappings, drawn straight from the catalog tags merged in GG2:
  - Gutendex / Caselaw Access / Musopen → `PD`.
  - CourtListener / RECAP / GovInfo / eCFR / Federal Register / US Code / FRED /
    BLS / Census / EIA / USDA NASS / NWS → `gov` (US government work, PD).
  - OpenAlex / Crossref / OpenCitations / DBLP / ORCID → `CC0`.
  - Jamendo / Freesound / ccMixter → `CC-BY` or `CC-BY-SA`, **CC-NC dropped from
    HOST** (the NC filter, AA2-3).
  - TMDB / Watchmode / Trakt / OMDb / Simkl / Radio Browser → `copyrighted-3p`
    with `sourceLicensed=false` for the underlying media (metadata only).
  - Dailymotion / Vimeo / Windy → `copyrighted-3p` with `sourceLicensed=true`
    (official licensed player).
- **Recognizable-rights `flags`** (`person | brand | model-release | trademark`)
  are set independently and never change posture — they queue a separate
  model-release / trademark review (AA2-3, AA2-4 `REVIEW_FLAGS`).
- `confidence` records how certain the family mapping is; low confidence on a
  HOST-eligible family is downgraded to AGGREGATE pending review (conservative
  default).

---

## 2. Step 2 — tier-route via the SB-A license-router (AA2-4)

The tag is fed to the **pure** router `tools/soapbox/license-router.mjs`
(`route(tag) -> POSTURE`). The decision table (verbatim from SB-A):

| Input                                                            | Tier        |
|-----------------------------------------------------------------|-------------|
| `licenseFamily ∈ {PD, CC0, CC-BY, CC-BY-SA, gov, user-original}` | **HOST**    |
| `copyrighted-3p` **and** `sourceLicensed === true`              | **EMBED**   |
| `copyrighted-3p` **and** `sourceLicensed === false`            | **REJECT**  |
| `CC-NC` (NonCommercial)                                          | **AGGREGATE** |
| `unknown` / malformed / low-confidence                          | **AGGREGATE** |

- **HOST** — SoapBox may serve the bytes (subject to the out-of-scope hosting/
  pinning layer); `attribution` carried through for CC-BY/CC-BY-SA.
- **EMBED** — windowed via an official licensed player only; the embed source host
  is checked against the official-player whitelist (EE2-11
  `design/media/embed-whitelist.json` + `design/media/youtube-embed-whitelist-spec.md`,
  EE2-12 `tools/media/iframe-embed-resolver.mjs`). A non-whitelisted host → REJECT even if
  `sourceLicensed` claims true.
- **AGGREGATE** — metadata + link-out only (JustWatch model); no bytes, no player.
- **REJECT** — not surfaced at all (the Napster→Grokster→Pirate-Bay line).

The router is the **source of truth**; a `tier` cached on the tag is advisory and
must equal `route(tag)` (re-routed on read, never trusted over the function).

**Cross-links:**
- Routing semantics: `design/soapbox/content-posture-spec.md` (AA2-1).
- Three-tier chain/storage/embed rule: `design/soapbox/melek-content-tiers.md` (AA2-2).
- DMCA/§512 actor boundary (only the surfaces SoapBox personally hosts are
  "actor" surfaces): `design/soapbox/dmca-512-posture.md` (AA2-6).
- Flag-don't-take-down moderation state machine: `design/soapbox/moderation-posture.md` (AA2-5).

### SB-D Library interaction

Library assets (Gutendex / Internet Archive / Open Library / Wayback,
DD2-1..6) flow through this same router. The Wayback adapters are **WINDOW-only**:
their tag is `pointer-only` → AGGREGATE → the spine stores the capture pointer and
never re-hosts the file (Hachette v. IA posture). See
`design/library/tier-routing-spec.md` (DD2-6) for the per-asset routing
walk; the spine delegates to it for Library records.

---

## 3. Step 3 — provenance chain

Every record carries an **append-only provenance chain** — the auditable trail of
where it came from and every transform applied. Each link:

```
{
  "source": "courtlistener",            // adapter id (tools/adapters/legal/courtlistener.mjs)
  "sourceUrl": "https://www.courtlistener.com/api/rest/v4/opinions/123/",
  "upstreamLicense": "US-Gov-Work",     // as the source published it
  "fetchedAt": "<iso-8601>",            // when the adapter pulled it
  "adapterVersion": "<semver>",         // adapter module version
  "transform": "tag-map|redact|route",  // step that produced this link
  "actor": "ingest-spine",              // generic role, never a person
  "prev": "<hash-of-previous-link>"     // chain back-pointer (tamper-evident)
}
```

- The chain is **content-addressed**: each link hashes `(prev, this-link-minus-hash)`
  so the head hash commits to the whole history (Merkle-style back-pointer). This is
  metadata only — it holds pointers/hashes/license tags, never copyrighted bytes
  (the immutable-chain rule, AA2-2).
- **Redaction is a provenance event.** For legal dockets/filings, the
  `design/soapbox/legal-redaction-rules.md` (BB2-11) `redact()` pass runs *before*
  display and appends a `transform: "redact"` link recording WHICH ruleset fired
  (sealed-filing / minor / PII) without echoing the redacted content. Sealed or
  minor-involving records may be downgraded to AGGREGATE or withheld by that pass
  regardless of license tier.
- The chain is **immutable once written**; a correction is a new appended link, not
  an edit (so the trail of "what we believed and when" survives).

---

## 4. Step 4 — transparency-score input

The head of the provenance chain + the license tag feed the **transparency-score**
the live SoapBox site already surfaces (R4; exporter
`tools/exporter/transparency-score.mjs`).
The spine emits, per record, the score inputs:

- `tier` (HOST/EMBED/AGGREGATE) — HOST/open-licensed scores highest, AGGREGATE
  lowest, REJECT never reaches scoring.
- `openAccess` + `licenseFamily` — open/PD/CC0 raises the score.
- `provenanceDepth` + `sourceVerified` — a complete, hash-linked chain to a known
  adapter raises it; missing/short chains lower it.
- `keyRequired` — gated sources are flagged (lower openness signal).
- `flags[]` present — pending rights review lowers confidence until cleared.

These are **inputs only**; the score formula and weights live in the
transparency-score spec. The spine guarantees the inputs are present and honest.

---

## 5. End-to-end record shape (engine output)

```jsonc
{
  "id": "courtlistener:opinion:123",
  "vertical": "law-soapbox",
  "payload": { /* normalized record from the adapter */ },
  "licenseTag": { "license": "US-Gov-Work", "licenseFamily": "gov",
                  "source": "courtlistener.com", "sourceLicensed": false,
                  "flags": [], "confidence": "high" },
  "tier": "HOST",                          // = route(licenseTag); recomputed on read
  "provenance": [ /* append-only chain, §3 */ ],
  "transparency": { "tier": "HOST", "openAccess": true, "keyRequired": false,
                    "provenanceDepth": 2, "sourceVerified": true }
}
```

---

## 6. Invariants (testable)

1. **Total routing.** Every record has exactly one `tier`, and `tier === route(licenseTag)`.
2. **No HOST without a host-eligible family.** A record may be HOST only if
   `licenseFamily ∈ HOST_FAMILIES` (router enforces; spine never overrides upward).
3. **No EMBED off-whitelist.** EMBED requires the embed host on the official-player
   whitelist; otherwise REJECT.
4. **Provenance present + linked.** Every record has ≥1 provenance link; each link's
   `prev` matches the prior link's hash (chain verifies head-to-tail).
5. **Redaction precedes display.** For legal verticals, a `redact` link exists before
   any HOST/AGGREGATE surfacing of docket/filing records.
6. **Metadata-only on chain.** No provenance link or tag carries copyrighted bytes —
   pointers/hashes/license tags only.
7. **Conservative on ambiguity.** `unknown` / low-confidence / malformed tags route to
   AGGREGATE, never HOST or EMBED.

---

## 7. Out-of-scope (named, not specified here)

- Live hosting / IPFS pinning / unpinning infra (the "takedown lever" surface).
- DMCA-agent registration; real takedown actions.
- Any server/IP/credential, founder PII, or paid/gated source account.
- The transparency-score weighting formula (lives in its own spec; this only feeds it).

---

## 8. Cross-reference index

| Step / piece                  | Artifact                                                        |
|-------------------------------|----------------------------------------------------------------|
| License-tag schema            | `tools/soapbox/schemas/license-tag.schema.json` (AA2-3)        |
| Tier router (pure fn)         | `tools/soapbox/license-router.mjs` (AA2-4)                     |
| Content-posture semantics     | `design/soapbox/content-posture-spec.md` (AA2-1)              |
| Three-tier chain/store/embed  | `design/soapbox/melek-content-tiers.md` (AA2-2)              |
| Moderation state machine      | `design/soapbox/moderation-posture.md` (AA2-5)                |
| DMCA/§512 actor boundary      | `design/soapbox/dmca-512-posture.md` (AA2-6)                  |
| Legal redaction pass          | `design/soapbox/legal-redaction-rules.md` (BB2-11)            |
| Library routing       | `design/library/tier-routing-spec.md` (DD2-6)                |
| Embed whitelist + resolver    | `design/media/embed-whitelist.json` + `design/media/youtube-embed-whitelist-spec.md` (EE2-11), `tools/media/iframe-embed-resolver.mjs` (EE2-12) |
| Transparency-score sink       | `tools/exporter/transparency-score.mjs` (R4)                 |
| Source catalog (tagged)       | `tools/brain/state/design/vkfri-resource-catalog.json` (GG2) |
| Adapter→consumer matrix       | `tools/adapters/consumers.json` (HH2-1)                       |
