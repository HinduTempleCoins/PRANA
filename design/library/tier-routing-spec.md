# Library tier-routing spec — HOST / WINDOW / AGGREGATE (DD2-6)

> Generic, public-safe routing rule for the public-domain / library adapters in
> `tools/adapters/library/`. It decides, for a catalog item, **how** we are
> allowed to put it in front of a user: serve the bytes ourselves (**HOST**),
> point at a capture/embed someone else serves (**WINDOW**), or surface only a
> link-out pointer (**AGGREGATE**). Nothing here names any private deployment,
> private host, or IP — it is a routing rule over license/source metadata only.

## Why this exists

The adapters here wrap public APIs over four kinds of object:

- public-domain books (Gutendex / Project Gutenberg),
- archive items with explicit rights metadata (Internet Archive),
- bibliographic metadata that points at access-controlled scans (Open Library),
- web captures (Wayback).

Each object arrives with a license/rights signal. The router maps that signal to
exactly one delivery tier so we never accidentally re-host something we are not
licensed to serve.

## The three tiers

| Tier | What we do | Use when | Who serves the bytes |
|------|------------|----------|----------------------|
| **HOST** | Serve the bytes (we may mirror/cache the file) | License family is **free-to-host**: PD, CC-BY, CC-BY-SA, CC0, gov/PD-by-statute, or user-original | us |
| **WINDOW** | Point at a capture/embed the source operates; render a link/iframe to it, never copy the bytes | Item is **copyrighted but there is a legitimate capture or official window** (e.g. a Wayback snapshot, an official embeddable player) | the source / archive |
| **AGGREGATE** | Store only metadata + a link-out pointer (title, cover, identifier) | Item is copyrighted with **no host-eligible license and no legitimate window**, or license is `unknown`/`CC-NC` | someone else, off-platform |

This is the same family of postures as the SoapBox content-posture spec
(`design/soapbox/content-posture-spec.md`, AA2-1) and is enforced by the same
**license-router** described there (AA2-4). The naming difference is intentional
and small:

- SoapBox calls the middle tier **EMBED** (an official licensed *player*); for
  library/archive objects the middle tier is **WINDOW** — a capture-window
  pointer (a Wayback snapshot or an embeddable reader) the **source** serves.
  WINDOW is the library-domain specialization of EMBED: a pointer into someone
  else's served bytes, never a re-host.
- HOST and AGGREGATE mean exactly the same thing in both specs. **Reuse the
  AA2-4 license-router**; this spec only adds the WINDOW/library mapping rows.

## Routing algorithm

For each candidate item, in order:

1. **Normalize the license** to a family: `PD | CC0 | CC-BY | CC-BY-SA | CC-NC |
   gov | user-original | copyrighted | unknown`. Sources of the signal:
   - Gutendex `copyright` tri-state (`false` ⇒ PD).
   - Internet Archive `licenseurl` / `rights` (e.g. a `publicdomain/mark` or a
     `creativecommons.org/licenses/...` URL).
   - Open Library `ebook_access` (`public` vs `borrowable`/`printdisabled`) plus
     any edition rights.
   - Wayback: captures are always treated as **WINDOW** (see below) regardless
     of the original page's license — we never re-host a capture.
2. **If the family is free-to-host** (`PD`, `CC0`, `CC-BY`, `CC-BY-SA`, `gov`,
   `user-original`) → **HOST**.
   - Carry attribution / share-alike obligations where the license requires it
     (CC-BY / CC-BY-SA).
3. **Else if a legitimate window exists** (a Wayback snapshot, or an official
   embeddable reader/player whose host is on the embed whitelist) → **WINDOW**.
   Store only the pointer (snapshot URL + timestamp, or video id + whitelisted
   host). Never copy the bytes.
4. **Else** (copyrighted with no window, or `CC-NC`, or `unknown`) →
   **AGGREGATE**. Surface the catalog pointer/link-out under the source's own
   terms only.

`CC-NC` is **not** host-eligible (this is a commercial-context platform); it
falls through to AGGREGATE, matching the AA2-4 rule. `unknown` is treated as
copyrighted-until-proven and routes to AGGREGATE.

## Per-adapter defaults

- **Gutendex** — `copyright:false` items are PD → **HOST**-eligible. The adapter
  returns Gutenberg format URLs as pointers; the router decides whether we also
  mirror the file (HOST) or just link it.
- **Internet Archive** — read `licenseurl`/`rights`. A `publicdomain` or
  open-CC item → **HOST**-eligible; an item with restrictive/absent rights →
  **AGGREGATE** (link to the archive.org item page). The adapter's `files[].url`
  are archive.org download POINTERS; HOST means we may additionally cache them,
  AGGREGATE means we only link the item page.
- **Open Library** — bibliographic metadata only; OL is **never** a HOST source
  by itself. `ebook_access:public` items usually have a PD scan on IA (follow
  the `ia`/`ocaid` pointer and re-run the IA rule); everything else →
  **AGGREGATE** (link to the OL work/edition page or the borrow flow).
- **Wayback** — **always WINDOW**. The adapter deals exclusively in capture
  POINTERS (snapshot URL + timestamp). We link to `web.archive.org`; we do
  **not**, under any tier, fetch or mirror the captured bytes. This is the
  single hard rule the Wayback adapter documents in its own header.

## Hard invariants

- **Never re-host a Wayback capture.** Wayback output is a pointer tier only.
- **Never HOST a `CC-NC` or `unknown`-license item.** Route to AGGREGATE.
- **WINDOW stores pointers, not bytes.** If the source pulls the capture/embed,
  the window goes dark on its own.
- The router makes **no** copyright determination beyond the license/rights
  signal the source itself publishes; ambiguous items default to the safer
  (more restrictive) tier.

## Cross-references

- License-router (canonical): `design/soapbox/content-posture-spec.md` (AA2-1)
  and its AA2-4 license-router — **reuse it**; this spec adds the WINDOW rows.
- DMCA §512 posture: `design/soapbox/dmca-512-posture.md`.
- Adapters: `tools/adapters/library/{gutendex,internet-archive,open-library,wayback}.mjs`.
- Self-host index: `design/library/gutendex-selfhost-note.md`.
