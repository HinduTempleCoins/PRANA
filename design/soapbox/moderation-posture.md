# SoapBox Moderation Posture — Flag, Don't Take Down (AA2-5)

> Private design artifact. PUBLIC-repo safe: generic moderation-posture rules only.
> Companion to the content-posture spec (AA2-1), the tier rule (AA2-2), and the DMCA
> §512 posture (AA2-6).

## 0. The default: flag, label, filter — never silently delete

SoapBox's default moderation move is **not removal**. It is to **flag / label / filter**
the content and route a **notice** through a channel, leaving the content in place. We are
a referee, not a judge: we surface that a dispute exists; we do not pronounce a verdict.

Two reasons:

1. **We are a content-agnostic protocol.** On the immutable chain layer there is no delete
   lever at all (AA2-2), so "take it down" is not even available there — the only honest
   move is to label.
2. **Adjudicating truth is both impossible and dangerous.** We cannot know that a copyright
   claim, a defamation claim, or a "this is stolen" claim is correct. Acting as if we do
   exposes us and misinforms users.

## 1. The cardinal rule: LABEL THE DISPUTE, NEVER RENDER THE VERDICT

- ✅ Safe: **"A complaint alleging X was filed against this content."**
- ❌ Unsafe: **"This content is stolen / infringing / false."**

The first reports a fact about the *process* (a complaint exists). The second is an
**adjudication** — it asserts the underlying claim is true. We only ever do the first. Every
user-facing label must be phrased as *"a [type] complaint was filed"*, attributed to the
complainant, never as the platform's own conclusion.

This applies uniformly: copyright, defamation, "misinformation," trademark, privacy. The
platform labels the *existence and type of the dispute* and links to the process; it never
stamps the underlying allegation as resolved.

## 2. Where removal CAN happen: hosted surfaces under a valid §512(c) notice

Removal is the exception, and it is mechanical, not editorial. It is available **only on
surfaces we actually host** (Tier 2 mutable storage — AA2-2), and only driven by the DMCA
§512(c) notice-and-counter-notice process (AA2-6). On those surfaces:

- a **valid §512(c) notice** → **disable access** (unpin) to the specific asset,
- a **valid counter-notice** → **restore** access after the statutory window,
- throughout, we behave as a **referee**: we check the notice is facially valid and route
  it; we do not weigh whether the copyright claim is ultimately correct.

On EMBED (Tier 3) and AGGREGATE surfaces there is nothing of ours to remove — the bytes are
the rights-holder's or off-platform — so the lever there is dropping the embed/pointer, not
a takedown.

## 3. The notice → disable → counter-notice → restore state machine

A hosted asset moves through these states. Transitions are driven by *valid* notices only;
an invalid/incomplete notice is rejected and does not move the state.

```
                 valid §512(c) notice
   [ LIVE ] ───────────────────────────────► [ DISABLED ]
      ▲                                            │
      │                                            │ valid counter-notice
      │ (no counter-notice within window:          ▼
      │  stays DISABLED)                      [ COUNTER_FILED ]
      │                                            │
      │       statutory window elapses,            │
      └────────── no court action filed ◄──────────┘
                  => RESTORED (back to LIVE)
```

States:

- **LIVE** — asset is served normally. A label may be attached (see §1) without changing
  this state; labeling is orthogonal to availability.
- **DISABLED** — a facially valid takedown notice arrived; access to the specific asset is
  disabled (unpinned). The uploader is notified and may counter-notify.
- **COUNTER_FILED** — the uploader filed a valid counter-notice. The asset stays DISABLED
  during the statutory waiting window.
- **RESTORED → LIVE** — the waiting window elapsed with no court action by the complainant;
  access is restored. (If the complainant files suit in time, the asset stays DISABLED
  pending the court — we still do not adjudicate.)

Repeat-infringer accounting is tracked out-of-band (a §512 safe-harbor requirement, AA2-6)
but does not auto-delete content; it governs account standing.

## 4. What this posture deliberately does NOT do

- It does not let the platform decide a claim is true or false.
- It does not silently delete content (every disable is notice-driven, logged, and
  reversible via counter-notice).
- It does not touch the immutable chain layer (nothing there is removable by design).
- It does not, by itself, register a DMCA agent or run live takedown infrastructure — that
  is operational and **OUT OF SCOPE** here (see AA2-6). This document specifies the *posture
  and state machine*; standing up the live agent/queue is named, not built.

## 5. See also

- `design/soapbox/content-posture-spec.md` (AA2-1)
- `design/soapbox/melek-content-tiers.md` (AA2-2)
- `design/soapbox/dmca-512-posture.md` (AA2-6)
- `tools/soapbox/license-router.mjs` (AA2-4)
