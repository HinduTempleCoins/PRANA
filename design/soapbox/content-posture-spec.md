# SoapBox Content-Posture Spec — HOST / EMBED / AGGREGATE (AA2-1)

> Private design artifact. PUBLIC-repo safe: generic posture/licensing rules only —
> no founder/server/credential specifics. This spec governs how any SoapBox surface
> may surface a third-party media or document asset without becoming a copyright
> infringer or a "secondary infringement" inducement target.

## 0. The one question that decides everything

> **"Is the source I am putting in front of the user itself licensed to deliver this content?"**

Everything below is a decomposition of that single test. There are exactly three
postures a SoapBox surface may take toward an asset, in increasing distance from the
bytes:

| Posture | What we do | When | Who serves the bytes |
|-----------|-----------|------|----------------------|
| **HOST** | We store/pin and serve the bytes ourselves | The asset is free-to-host (PD, CC, government work, or user-original) | **us** |
| **EMBED** | We render an official, licensed player/iframe that the rights-holder operates | The asset is copyrighted but the rights-holder publishes an official embeddable player | **the rights-holder** |
| **AGGREGATE** | We store only metadata + a link-out (title, art, a pointer) — JustWatch model | The asset is copyrighted and there is no embeddable official player we may use | **someone else, off-platform** |

A fourth outcome, **REJECT**, is not a posture — it is the refusal that happens when a
candidate fails all three (e.g. an unlicensed scraper-iframe of a current film). REJECT
means "do not surface this asset at all."

## 1. HOST — we serve the bytes

**Use HOST only when the asset is free-to-host.** Concretely, the license family must be
one of:

- **PD** — public domain (expired copyright, US-government work, dedicated PD).
- **CC0** — Creative Commons "no rights reserved."
- **CC-BY / CC-BY-SA** — Creative Commons attribution (we MUST carry the attribution
  string; SA obligations propagate to derivatives).
- **gov** — works of a government that are PD-by-statute or open-licensed.
- **user-original** — content the uploading user authored and is licensing to us.

**CC-NC (NonCommercial) is NOT host-eligible.** SoapBox is part of a value/compute
ecosystem; treating an NC asset as freely hostable risks a commercial-use violation.
NC assets fall through to AGGREGATE (link to the source under its own terms), never HOST.
The license-router (AA2-4) enforces this.

When we HOST, we are the "actor": these are the surfaces where the DMCA §512 posture
(AA2-6) and the flag/take-down state machine (AA2-5) actually bite, because we control
the bytes and can unpin them.

## 2. EMBED / WINDOW — the rights-holder serves the bytes

**Use EMBED when the asset is copyrighted but the rights-holder offers an official,
licensed embeddable player.** Canonical examples: a YouTube `<iframe>`, a Vimeo player,
a Dailymotion player, a 3Speak player. The rights-holder (or their licensed distributor)
operates that player, runs their own ads/analytics, and bears the licensing — we are a
referrer, not a re-host.

The decisive property is **`sourceLicensed === true`**: the embed target must itself be
authorized to deliver the content. A YouTube embed of a label's official music video is
fine because YouTube + the label settled the license. The exact same song delivered by a
random `2embed`/scraper iframe is **not** fine — that source is not licensed, so it is
REJECT, not EMBED.

EMBED never copies the bytes onto our infrastructure. The window shows the rights-holder's
stream; if they pull it, the window goes dark on its own. We store only the embed pointer
(a video id + the whitelisted host), governed by the embed-whitelist player spec
(EE2-11/EE2-12, separate item).

## 3. AGGREGATE / POINT — we serve only a pointer

**Use AGGREGATE when the asset is copyrighted and there is no embeddable official player
we may use.** This is the **JustWatch model**: we store title, year, cover art (used
under metadata/fair-use norms the way a catalog does), a synopsis, and a **link-out** to
where the user can legitimately access it (the official storefront/stream/library). We
serve no bytes and no player — just discovery metadata and a doorway.

AGGREGATE is the safe default for "we want users to find this, but we are not licensed to
deliver it." It is also where CC-NC and `unknown`-license assets land: surface the pointer
under the source's own terms, never re-host.

## 4. The legal boundary: Napster → Grokster → Pirate Bay

The three postures map onto the line that case law has drawn between a lawful index and an
infringement machine:

- **Napster (A&M v. Napster, 2001).** A central index that knowingly pointed users at
  infringing files and had the ability to police them was contributorily/vicariously
  liable. Lesson: **a pointer + knowledge + control + commercial benefit can still infringe.**
  Our AGGREGATE pointers must point at *legitimate* destinations, not at infringing copies.
- **Grokster (MGM v. Grokster, 2005).** **Inducement** — building/marketing a tool with the
  object of promoting infringement — is liable even without direct knowledge of each act.
  Lesson: **do not design or message any surface as an infringement tool.** A scraper that
  "finds the free stream of any movie" is inducement-shaped; refuse it.
- **The Pirate Bay.** A pure tracker/index that nonetheless existed to deliver infringing
  content was held liable in multiple jurisdictions. Lesson: **"we only store links/hashes"
  is not a magic shield** if the obvious and intended use is infringement.

The defensible side of this line: index/point at **licensed or non-infringing** sources
(JustWatch, a library catalog, an official store), embed **official licensed players**, and
host **only free-to-host bytes**. The router (AA2-4) + the model-release/trademark flags
(AA2-3) keep us on that side mechanically.

## 5. Worked examples

| Candidate asset | License / source | Posture | Why |
|-----------------|------------------|---------|-----|
| 1915 PD silent film, our scan | PD | **HOST** | Free to host; we serve the bytes. |
| CC-BY-SA photo from Wikimedia | CC-BY-SA | **HOST** (carry attribution) | Free to host; SA + attribution obligations attach. |
| User's own uploaded video | user-original | **HOST** | The uploader authored + licensed it. |
| CC-NC indie track | CC-NC | **AGGREGATE** | NonCommercial — not host-eligible for a commercial platform; link out. |
| Label's official music video on YouTube | copyrighted, `sourceLicensed=true` | **EMBED** | Official licensed player; rights-holder serves bytes. |
| Same song via a `2embed`/scraper iframe | copyrighted, `sourceLicensed=false` | **REJECT** | Source is not licensed → inducement-shaped, refuse. |
| Current theatrical film, full file from a random host | copyrighted, `sourceLicensed=false` | **REJECT** | Unlicensed host of a current film — the Pirate-Bay line; refuse. |
| Current film, "where to watch" entry | copyrighted, no embeddable player | **AGGREGATE** | JustWatch model: metadata + link to the official store. |
| Photo of a recognizable person/brand, otherwise CC | CC-BY **+ person/brand flag** | **HOST**, but flagged | License permits hosting; the `flags` (person/brand) trigger an independent model-release/trademark review before promotion. |

## 6. How this is enforced

1. Every ingested asset gets a **license tag** conforming to `license-tag.schema.json`
   (AA2-3): `{license, licenseFamily, source, sourceLicensed, flags, provenance, confidence}`.
2. The **license-router** (`tools/soapbox/license-router.mjs`, AA2-4) is a pure function
   `licenseTag → HOST | EMBED | AGGREGATE | REJECT`. Tag once, route deterministically.
3. `person` / `brand` / `model-release` / `trademark` flags do **not** change the posture
   by themselves but mark the asset for an independent rights review (right-of-publicity,
   trademark) before it is promoted on any HOST surface.
4. On HOST surfaces, the moderation posture (AA2-5) and DMCA §512 posture (AA2-6) provide
   the notice → disable → counter-notice → restore lever.

## 7. See also

- `design/soapbox/melek-content-tiers.md` (AA2-2) — the three-tier chain/storage/embed rule.
- `design/soapbox/moderation-posture.md` (AA2-5) — flag-don't-take-down.
- `design/soapbox/dmca-512-posture.md` (AA2-6) — §512 safe-harbor checklist.
- `tools/soapbox/schemas/license-tag.schema.json` (AA2-3) — the per-asset tag.
- `tools/soapbox/license-router.mjs` (AA2-4) — the deterministic router.
