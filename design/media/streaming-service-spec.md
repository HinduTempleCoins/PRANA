# Streaming Service Spec — the Entertainment vertical (SX3)

> SoapBox Media / **Entertainment** vertical, Master Build Synthesis §3b. A
> Netflix/Tubi-style video service that **sits beside News in `Data.SoapBox`**. It
> is the same three-posture content discipline as everything else — applied to film
> and TV.
>
> **PUBLIC FILE.** Public-repo safe: posture/licensing architecture, real services,
> and real case law only. No founder PII, no server/IP/credentials, no
> hosting/pinning/CDN infra. Byte-serving infrastructure is named as out-of-scope
> where the spec touches it, never specified here.
>
> **This spec does NOT re-derive the posture rules or the embed mechanics.** The
> HOST/EMBED/AGGREGATE license-router is `design/soapbox/content-posture-spec.md`
> (AA2-1); the official-iframe whitelist + resolver are
> `design/media/youtube-embed-whitelist-spec.md` (EE2-11) and
> `tools/media/iframe-embed-resolver.mjs` (EE2-12). This spec binds them to the
> video vertical, it does not duplicate them.

---

## 0. The one test (inherited, not re-invented)

The whole service is a decomposition of the single question the content-posture
spec already poses:

> **"Is the source I am putting in front of the user itself licensed to deliver this content?"**

There is no special "movie law." A film is just an asset; it gets a license tag and
the deterministic `license-router` (AA2-4) routes it to one of three buckets, or
REJECTs it. The three buckets below ARE the HOST / EMBED / AGGREGATE postures from
AA2-1, instantiated for video.

---

## 1. The three buckets

### 1a. HOST — public-domain films we serve (via the rights-holder-free archive)

**Use HOST only when the film is free-to-host: public domain.** Concretely:

- **Internet Archive feature films** — the large IA collection of **public-domain
  feature films** (expired-copyright cinema, films that fell out of copyright for
  failure to renew, etc.).
- **Prelinger Archives** — the IA-hosted collection of "ephemeral" films
  (advertising, educational, industrial, amateur) that Rick Prelinger placed largely
  in the public domain.
- **Rule of thumb / safe cut line:** treat **1930-and-earlier** US works as the
  conservative PD floor, and otherwise rely on a verified PD/renewal status per
  title. (The exact PD cutoff advances each year and has renewal/restoration
  wrinkles — the per-title license tag is the source of truth, not the year alone.)

**Bandwidth note — embed IA's own player even for HOST-class PD.** Although these
films are free for us to host, we **do not have to serve the bytes ourselves**. The
Internet Archive operates an **official embeddable player** (`archive.org/embed/{id}`)
— already an allow-listed provider in the embed whitelist
(`design/media/embed-whitelist.json`, `provider: "archive"`). For PD films we
therefore **embed IA's player** to save our bandwidth/storage while still being
fully in the clear (the content is PD *and* the source is licensed to deliver it).
This is HOST-eligible content delivered through an EMBED window — the cheapest
correct option. (Self-hosting the bytes remains available for any PD title we
specifically want resilient/offline, but it is the exception, and the byte-serving
infra is out-of-scope for this public file.)

### 1b. EMBED — official licensed players (the rights-holder serves the bytes)

**Use EMBED when the title is copyrighted but the rights-holder publishes an
official, licensed player.** The decisive property is **`sourceLicensed === true`**
(AA2-1 §2): the embed target must itself be authorized to deliver the content.

Allowed players are exactly the embed whitelist (deny-by-default), enforced by the
resolver:

| provider | official embed host | used here for |
| --- | --- | --- |
| `youtube` | `www.youtube-nocookie.com` | official channels, full films/shows posted by the rights-holder, trailers |
| `dailymotion` | `geo.dailymotion.com` | official catalog uploads |
| `vimeo` | `player.vimeo.com` | indie/creator official releases |
| `threespeak` | `3speak.tv` | ecosystem-native (Hive/3Speak) video |
| `archive` | `archive.org` | the IA player from §1a (PD films) |

A YouTube embed of a studio's **official** full film is fine because YouTube + the
studio settled the license. The **exact same film** delivered by a scraper iframe is
**not** fine — that source is unlicensed → REJECT, not EMBED (§2). We store only the
embed pointer (`provider` + validated `id`); we never copy the stream. All embeds go
through `resolveEmbed()` (EE2-12) and render under the fixed sandbox / click-to-start
contract from the whitelist spec (EE2-11) — no author JS, ever.

### 1c. AGGREGATE — the JustWatch-model discovery spine (we serve only a pointer)

**Use AGGREGATE when the title is copyrighted and there is no embeddable official
player we may use** — the overwhelming majority of "current movies and shows." This
is the **JustWatch model**: we store **metadata + cover art + a "where to watch"
link-out** to the legitimate storefront/stream, and **serve no bytes and no player.**

The discovery spine is built from the **SB-E2 discovery adapters** (bind these by
path — do not reimplement):

| Adapter | Role in the spine | Source-of-truth header |
| --- | --- | --- |
| `tools/adapters/media/tmdb.mjs` (EE2-7) | **Metadata** — canonical title/cast/artwork/synopsis the whole vertical hangs off | TMDB |
| `tools/adapters/media/watchmode.mjs` (EE2-8) | **Where-to-watch** — per-region streaming sources + offer type (sub/free/rent/buy) | Watchmode |
| `tools/adapters/media/trakt.mjs` (EE2-9) | **History / lists** — what a user watched, their lists, trending/popular charts | Trakt |
| `tools/adapters/media/omdb-simkl.mjs` | supplementary ratings/availability metadata | OMDb / Simkl |

The AGGREGATE record carries **no playable bytes** — just discovery metadata under
the catalog/metadata-fair-use norm the content-posture spec describes (AA2-1 §3), and
a **link-out to where the user can legitimately access the title** (the official
store/stream surfaced by Watchmode). This is the safe default for "we want users to
find it, but we are not licensed to deliver it."

---

## 2. REFUSE scraper iframes — the `sourceLicensed` test

**Hard refusal: scraper iframes / "free current movies" embeds.** 2Embed-style
sources (2embed, vidsrc, embedsito/fembed, streamtape, doodstream, mixdrop,
gomovies, fmovies, …) are **pirated content + a malware vector** (malvertising,
forced-redirect, drive-by). They are listed in the whitelist's `denyHosts` and, more
importantly, are caught by **deny-by-default**: any host not on the five-provider
allow-list is refused, with the scraper list as belt-and-suspenders.

The mechanism is already built — this spec binds it, it does not reinvent it:

- **The is-the-source-licensed test** is `sourceLicensed === true` in the license
  tag. A current film delivered by a scraper iframe is `sourceLicensed=false` →
  **REJECT** (content-posture spec §5 worked examples; "Same song / current film via
  a `2embed`/scraper iframe → REJECT").
- **The enforcing code** is `tools/media/iframe-embed-resolver.mjs` (EE2-12):
  `resolveEmbed()` refuses off-list hosts (`HOST_NOT_ALLOWED`), known scrapers
  (`SCRAPER_HOST`), non-https (`BAD_SCHEME`), and script-smelling input
  (`SCRIPT_SMELL`) with typed errors, and host-matches by exact-or-true-subdomain so
  `youtube.com.evil.tld` never matches. A scraper iframe can never be rendered, even
  if a record mis-tags it.

> The same wound that killed the MySpace era — letting page-supplied content run
> arbitrary JS — would here drain a wallet (we carry keys in the same app). So the
> embed rule is absolute (EE2-11 §0): the only script that runs inside any video
> window is the **official provider's own player** from the **official origin** in a
> **sandboxed iframe**.

---

## 3. The legal frame — be a *window*, not a *host*

Same case-law line as the content-posture spec (AA2-1 §4), stated for video. The
defensible posture is **window, not host**:

- **Napster (*A&M Records v. Napster*, 9th Cir. 2001).** A central index that
  knowingly pointed users at infringing files, with the ability to police them, was
  contributorily/vicariously liable. **Lesson:** our AGGREGATE "where to watch"
  pointers must point at **legitimate** destinations (official stores/streams via
  Watchmode), never at infringing copies.
- **Grokster (*MGM Studios v. Grokster*, U.S. 2005).** **Inducement** — building or
  marketing a tool *with the object of promoting infringement* — is liable even
  without knowledge of each act. **Lesson:** a feature that "finds the free stream of
  any current movie" is inducement-shaped by design; we refuse it (§2). We do not
  message or build the service as a piracy tool.
- **The Pirate Bay.** A pure tracker/index that nonetheless **existed to deliver
  infringing content** was held liable across jurisdictions. **Lesson:** "we only
  store links/metadata" is **not** a magic shield when the obvious intended use is
  infringement. Our index points at PD bytes (HOST/IA), official players (EMBED), and
  licensed storefronts (AGGREGATE) — never at the infringing copy.

The defensible side of the line, concretely: **HOST only free-to-host (PD) bytes,
EMBED only official licensed players, AGGREGATE only legitimate destinations,
REJECT everything else.** The license-router (AA2-4) keeps us on that side
mechanically; on the HOST surfaces, the DMCA §512 posture
(`design/soapbox/dmca-512-posture.md`, AA2-6) and the flag/take-down state machine
(AA2-5) provide the notice → disable → counter-notice → restore lever.

---

## 4. The FAST-channel lift (later, licensed)

The **Tubi / Pluto TV model** — free, ad-supported streaming with **FAST channels**
(Free Ad-Supported Streaming TV: linear, always-on, ad-monetized channels plus an
on-demand library) — is the natural growth path **once licensed content deals
exist.** It is explicitly a **later phase**, not a launch posture:

- **Launch** = the three buckets above (PD HOST via IA, official EMBED, JustWatch
  AGGREGATE). Zero licensing tail; clean from day one.
- **Later lift** = strike **licensed distribution deals** (like Tubi/Pluto did) to
  add an on-demand library and **FAST linear channels** under real licenses. That
  unlocks bucket-1 hosting of *current/licensed* catalog and ad-supported linear
  programming — but it requires the rights, which is a business-development and
  rights-clearance effort, **not** something the scraper-iframe path can shortcut.
- The PD/CC **scoring/bumpers/channel music** for any FAST channel come from the
  AI-music stack (SX1, `design/media/ai-music-stack.md`) — host-eligible audio with
  no licensing tail, so the linear-channel wrapper is clean even before catalog deals.

---

## 5. Where this sits

- **Vertical placement:** the **Entertainment** vertical **beside News** in
  `Data.SoapBox`, both riding the shared **data spine**
  (`design/soapbox/data-spine-ingest-spec.md`, HH2-2): every title is license-tagged
  (AA2-3), tier-routed (AA2-4), and provenance-stamped before any surface shows it.
- **No new posture machinery.** Film/TV reuse the exact HOST/EMBED/AGGREGATE router,
  embed whitelist, resolver, DMCA §512 posture, and moderation state machine that
  already govern documents, audio, and images. This spec is binding glue between the
  SB-E2 video adapters and that machinery — nothing more.

## 6. See also

- `design/soapbox/content-posture-spec.md` (AA2-1) — HOST/EMBED/AGGREGATE + the deterministic license-router (do not duplicate).
- `design/media/youtube-embed-whitelist-spec.md` (EE2-11) — the official-iframe player contract.
- `design/media/embed-whitelist.json` — the five-provider allow-list + scraper deny-list (includes IA `archive` + the 2Embed family).
- `tools/media/iframe-embed-resolver.mjs` (EE2-12) — the pure resolver that refuses scraper hosts.
- `tools/adapters/media/{tmdb,watchmode,trakt,omdb-simkl}.mjs` (SB-E2) — the JustWatch-model discovery spine.
- `design/media/ai-music-stack.md` (SX1) — the audio sibling vertical (scoring/bumpers/channel music).
- `design/soapbox/data-spine-ingest-spec.md` (HH2-2) — the shared ingest/tier/provenance spine under News + Entertainment.
- `design/soapbox/dmca-512-posture.md` (AA2-6) — the §512 safe-harbor lever on HOST surfaces.
