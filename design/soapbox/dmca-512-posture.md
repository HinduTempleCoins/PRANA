# SoapBox DMCA §512 Safe-Harbor Posture (AA2-6)

> Private design artifact. PUBLIC-repo safe: generic legal-posture rules only —
> no founder/server/credential specifics, no live infrastructure.
>
> **SCOPE: SPEC ONLY.** This document records the posture and checklist. The actual
> *registration of a DMCA agent* with the Copyright Office, running live
> pinning/unpinning infrastructure, and any real takedown action are **OUT OF SCOPE**
> here — named below, deliberately not built.

## 0. Where the platform is an "actor"

DMCA §512 (17 U.S.C. §512) obligations attach **only where we are the actor** — i.e. only
on **surfaces we personally host / pin**. That is **Tier 2 mutable storage** (see
`melek-content-tiers.md`, AA2-2). Everywhere else, our exposure is structurally limited:

- **Tier 1 (immutable chain)** — we store pointers/hashes/social-graph only; this is
  conduit-shaped (§512(a)-like), nothing copyrighted is stored, and there is nothing to take
  down by design.
- **Tier 3 (front-end embed)** — copyrighted media is served by the rights-holder's own
  official player; we host no copy, so there is nothing of ours to take down.
- **AGGREGATE surfaces** — metadata + link-out only; no hosted copy.

**Therefore the DMCA agent + the unpin lever live exactly at Tier 2**, the only place we act
as a §512(c) "service provider … storing material at the direction of a user." This document
specifies the safe-harbor checklist for that surface.

## 1. The §512(c) safe-harbor checklist (user-uploads we host)

To preserve the §512(c) safe harbor for user-uploaded content we host, the platform must
satisfy each of the following. (Statutory requirements summarized in plain terms; this is a
posture spec, not legal advice.)

1. **Designated agent — registered + published.**
   - Register a DMCA agent with the U.S. Copyright Office (DMCA Designated Agent Directory)
     and publish the agent's contact info on the site.
   - ⛔ **OUT OF SCOPE here:** the actual registration filing. Documented, not performed.

2. **No actual knowledge; no red flags.**
   - We do not have actual knowledge that specific hosted material is infringing, and we are
     not aware of facts making infringement apparent ("red flag" knowledge).
   - This is why the moderation posture (AA2-5) **labels the dispute, never adjudicates** —
     forming/asserting a conclusion about infringement would manufacture knowledge.

3. **No financial benefit directly attributable to infringing activity that we have the
   right and ability to control.**
   - Generic platform monetization is fine; we do not monetize *specific* infringing items
     we control. The license-router (AA2-4) keeps copyrighted-3p bytes off our hosted tiers
     in the first place, which structurally reduces this exposure.

4. **Expeditious takedown on a valid notice.**
   - On a facially valid §512(c)(3) notice, **expeditiously disable access** (unpin the
     specific Tier-2 asset). This is the `LIVE → DISABLED` transition of the AA2-5 state
     machine.

5. **Counter-notice + restore.**
   - Notify the uploader; on a valid §512(g) counter-notice, **restore** access after the
     statutory waiting window unless the complainant files suit. (`DISABLED → COUNTER_FILED
     → RESTORED` in AA2-5.)

6. **Repeat-infringer policy — adopted, published, reasonably implemented.**
   - Maintain and enforce a policy for terminating repeat infringers' accounts in
     appropriate circumstances. Tracked at the account level; does not auto-delete content.

7. **Accommodate standard technical measures.**
   - Do not interfere with standard technical measures used by rights-holders to identify or
     protect works.

## 2. Anatomy of a valid §512(c)(3) notice

A notice we act on must, in substance, contain:

- identification of the copyrighted work claimed to be infringed;
- identification of the allegedly infringing material with enough detail to locate it (the
  Tier-2 asset / URL / CID);
- the complainant's contact information;
- a **good-faith-belief** statement that the use is unauthorized;
- a statement, under penalty of perjury, that the information is accurate and the
  complainant is authorized to act for the owner;
- the complainant's physical or electronic signature.

A notice missing the substantive elements is **not a valid notice** and does not, by itself,
create knowledge or trigger the takedown obligation — it is rejected/queued for cure, and
the asset stays `LIVE` (with at most a "complaint filed" label, never a verdict).

## 3. How the posture wires into the rest of the system

- **license-router (AA2-4)** keeps copyrighted-3p bytes off Tier 1/Tier 2 entirely (EMBED or
  AGGREGATE only), so the §512(c) host surface mostly carries PD/CC/licensed/user-original
  content — minimizing the takedown surface from the start.
- **moderation posture (AA2-5)** supplies the referee behavior and the
  notice→disable→counter-notice→restore state machine that §512(c)/(g) require, plus the
  label-the-dispute-never-render-the-verdict rule that protects the "no knowledge" prong.
- **tier rule (AA2-2)** localizes the agent + unpin lever to Tier 2, the one place we act as
  a §512(c) host.

## 4. OUT OF SCOPE (named, deliberately not built)

- **Registering a DMCA agent** with the Copyright Office (a real filing + fee + published
  contact). Documented as a required step; not performed here.
- **Running live pinning/unpinning infrastructure** (the actual storage nodes and the
  operational unpin action).
- **Any real takedown action** against real content.
- Any founder/entity/contact specifics or server details — excluded by mandate.

This file specifies *what the posture is and the checklist to satisfy it*. Standing up the
live agent, infrastructure, and queue is an operational/legal step for the operator, outside
this repo.

## 5. See also

- `design/soapbox/content-posture-spec.md` (AA2-1)
- `design/soapbox/melek-content-tiers.md` (AA2-2)
- `design/soapbox/moderation-posture.md` (AA2-5)
- `tools/soapbox/license-router.mjs` (AA2-4)
