# MELEK Three-Tier Content Rule (AA2-2)

> Private design artifact. PUBLIC-repo safe: generic content-tier / licensing rules only.
> Companion to `content-posture-spec.md` (HOST/EMBED/AGGREGATE). Where that spec asks
> *"what posture does a surface take toward an asset?"*, this rule asks *"what may live at
> each layer of the stack — immutable chain, mutable storage, front-end embed?"*

## 0. Why a tiered rule

A blockchain-backed social/value platform has three structurally different places content
can sit, and they have **structurally different takedown properties**. Copyright law treats
them differently, so we must too. The single governing principle:

> **The deeper / more permanent the layer, the cleaner the content's license must be.**
> Copyrighted media never goes on the immutable layer; the only place it appears is a
> front-end embed served by the rights-holder.

This is the on-chain expression of the "content-agnostic protocol" idea: the protocol
itself carries only neutral, license-clean primitives, and copyrighted media is always one
hop away, served by whoever is actually licensed to serve it.

## 1. The three tiers

### Tier 1 — Immutable chain (the most restrictive)

**Permanently recorded; cannot be deleted.** Because there is no takedown lever, only
content that never needs taking down may go here:

- pointers / content hashes / CIDs,
- transactions and on-chain state,
- the social graph (follows, likes, tips, memberships),
- **user-original text** the author published,
- references to **PD / openly-licensed** works (a citation, a hash of a PD scan).

**NEVER on chain: copyrighted third-party media bytes.** Not even "for a moment." Once it
is immutable, an infringing copy can never be unpinned — that is the one mistake with no
remedy. The chain stores the *pointer* to media, never the copyrighted media itself.

### Tier 2 — Mutable storage (pinning / object store)

**Storable but removable. Unpinning IS the takedown lever.** This is where bytes we are
allowed to serve live:

- **PD / CC0 / CC-BY / CC-BY-SA** assets (CC-NC excluded, per the posture spec),
- explicitly **licensed** assets,
- **user-original** uploads.

Because this layer is mutable, it is the surface that carries DMCA §512(c) host
obligations: a valid notice → **unpin** (disable access); a counter-notice → re-pin
(restore). The unpin operation is the concrete "take it down" action the safe-harbor
contemplates. (See AA2-5 moderation posture and AA2-6 §512 posture.)

### Tier 3 — Front-end embed (the only home for copyrighted media)

**Rendered, never stored by us.** Copyrighted third-party media appears ONLY as an
**embedded official licensed player** (YouTube, Vimeo, Dailymotion, 3Speak, etc.) inside
the front-end. The rights-holder serves the stream; we serve a whitelisted iframe pointer.
Nothing copyrighted is copied to Tier 1 or Tier 2. If the rights-holder pulls the content,
the embed simply goes dark — we took no copy.

| Tier | Mutability | Allowed content | Takedown lever |
|------|-----------|-----------------|----------------|
| 1 — chain | immutable | pointers, hashes, CIDs, txns, social graph, user-original text, PD-licensed refs | **none** (so: nothing copyrighted, ever) |
| 2 — storage | mutable | PD / CC0 / CC-BY(-SA) / licensed / user-original bytes | **unpin** = the takedown |
| 3 — embed | rendered, not stored | copyrighted media via official licensed players only | rights-holder pulls / we drop the embed pointer |

## 2. How the tiers map onto HOST / EMBED / AGGREGATE

The posture spec and the tier rule are two views of the same machine:

- **HOST** posture writes a **pointer to Tier 1** and the **bytes to Tier 2**. Only
  free-to-host families reach HOST, so only license-clean bytes ever touch Tier 2, and only
  a hash/pointer (never the bytes) ever touches Tier 1.
- **EMBED** posture writes **only an embed pointer** (a whitelisted host + id) — it touches
  **Tier 3** at render time and Tier 1 only as a neutral pointer. No bytes anywhere on us.
- **AGGREGATE** posture writes **only metadata + a link-out** — Tier 1 may hold the neutral
  pointer; nothing is hosted or embedded.

## 3. The legal reasoning (why the tiers are defensible)

- **Sony (Sony v. Universal, 1984) — substantial non-infringing use.** A neutral,
  content-agnostic protocol whose primary capability is lawful (pointers, social graph,
  PD/licensed media) is not contraband merely because someone *could* misuse it. The tier
  rule keeps the protocol's on-chain layer strictly neutral so this defense holds.
- **§512(a) conduit vs §512(c) host — different shelters for different layers.** A pure
  transmission/pointer layer behaves like a §512(a) conduit (no stored copy to take down).
  A layer that **stores** user content at their direction is a §512(c) host and must offer
  notice-and-takedown. Tier 1 is conduit-shaped (pointers only); **Tier 2 is the §512(c)
  host** and is exactly where we accept notices and unpin. Drawing the line at the tier
  boundary keeps each layer inside the right shelter.
- **Grokster inducement — design intent matters.** Because copyrighted media is confined to
  rights-holder-served embeds (Tier 3) and never hosted/recorded by us, the system is not
  built or marketed to deliver infringing copies. The tier rule is the architectural proof
  that we are a content-agnostic protocol, not an inducement machine.

## 4. Enforcement hooks

- The **license-router** (AA2-4) decides HOST/EMBED/AGGREGATE/REJECT per asset; this rule
  decides which tier each posture is allowed to write.
- An ingest guard MUST reject any attempt to place a `copyrighted-3p` (or `unknown`) asset's
  **bytes** on Tier 1 or Tier 2 — those may only be EMBED (Tier 3) or AGGREGATE.
- CC-NC assets are excluded from Tier 2 HOST (commercial-platform NonCommercial conflict);
  they route to AGGREGATE.

## 5. See also

- `design/soapbox/content-posture-spec.md` (AA2-1)
- `design/soapbox/moderation-posture.md` (AA2-5)
- `design/soapbox/dmca-512-posture.md` (AA2-6)
- `tools/soapbox/schemas/license-tag.schema.json` (AA2-3)
- `tools/soapbox/license-router.mjs` (AA2-4)
