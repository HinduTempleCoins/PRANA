// license-router.mjs — pure license-tag -> serving-posture router (AA2-4).
//
// Given a per-asset license tag (tools/soapbox/schemas/license-tag.schema.json),
// decide which content posture a SoapBox surface may take toward the asset:
//
//   HOST      — we serve the bytes ourselves (free-to-host: PD/CC0/CC-BY/CC-BY-SA/
//               gov/user-original).
//   EMBED     — copyrighted, but the source is an official LICENSED player we may
//               window (sourceLicensed === true).
//   AGGREGATE — copyrighted with no licensable embed, OR CC-NC (NonCommercial, not
//               host-eligible for a commercial platform), OR unknown — store metadata
//               + a link-out only (JustWatch model).
//   REJECT    — copyrighted via an UNLICENSED source (scraper/2embed of current media):
//               the Napster->Grokster->Pirate-Bay line. Do not surface at all.
//
// This module is PURE: no I/O, no clock, no randomness. Deterministic decision table,
// trivially unit-testable. The "tag every asset -> ingest auto-routes" engine (doc §5).
//
// PUBLIC FILE: generic posture/licensing logic only; no founder/server/credential refs.
//
// See: design/soapbox/content-posture-spec.md (AA2-1),
//      design/soapbox/melek-content-tiers.md (AA2-2).

/** The four routing outcomes. */
export const POSTURE = Object.freeze({
  HOST: 'HOST',
  EMBED: 'EMBED',
  AGGREGATE: 'AGGREGATE',
  REJECT: 'REJECT',
});

/**
 * License families that are free for us to host (we serve the bytes ourselves).
 * NOTE: CC-NC is deliberately ABSENT — NonCommercial is not host-eligible for a
 * commercial platform, so it falls through to AGGREGATE.
 * @type {ReadonlySet<string>}
 */
export const HOST_FAMILIES = Object.freeze(
  new Set(['PD', 'CC0', 'CC-BY', 'CC-BY-SA', 'gov', 'user-original']),
);

/** Independent rights flags that require a separate review (do not change posture). */
export const REVIEW_FLAGS = Object.freeze(
  new Set(['person', 'brand', 'model-release', 'trademark']),
);

/**
 * A minimal license tag, per license-tag.schema.json. Only the fields the router
 * reads are documented here.
 * @typedef {Object} LicenseTag
 * @property {string} licenseFamily - PD|CC0|CC-BY|CC-BY-SA|CC-NC|gov|user-original|copyrighted-3p|unknown
 * @property {boolean} [sourceLicensed] - for copyrighted-3p: is the embed source an official licensed player?
 * @property {string[]} [flags] - person|brand|model-release|trademark
 */

/**
 * Route a license tag to a serving posture. Pure + total: every input yields exactly
 * one POSTURE value; malformed/unknown families resolve conservatively to AGGREGATE
 * (never HOST/EMBED — we never serve bytes or a player we cannot justify).
 *
 * Decision table:
 *   PD | CC0 | CC-BY | CC-BY-SA | gov | user-original           -> HOST
 *   copyrighted-3p  &&  sourceLicensed === true                 -> EMBED
 *   copyrighted-3p  &&  sourceLicensed !== true                 -> REJECT
 *   CC-NC                                                        -> AGGREGATE
 *   unknown / anything else                                     -> AGGREGATE
 *
 * @param {LicenseTag} tag
 * @returns {('HOST'|'EMBED'|'AGGREGATE'|'REJECT')}
 */
export function routeLicense(tag) {
  if (!tag || typeof tag !== 'object') return POSTURE.AGGREGATE;

  const family = tag.licenseFamily;

  // Free-to-host families: we serve the bytes ourselves.
  if (HOST_FAMILIES.has(family)) return POSTURE.HOST;

  // Copyrighted third-party: the single decisive question is whether the SOURCE we
  // would put in front of the user is itself licensed to deliver the content.
  if (family === 'copyrighted-3p') {
    return tag.sourceLicensed === true ? POSTURE.EMBED : POSTURE.REJECT;
  }

  // CC-NC (NonCommercial) and unknown/everything-else: never host, never claim a
  // licensed embed — point at the source under its own terms.
  return POSTURE.AGGREGATE;
}

/**
 * Does this tag require an independent right-of-publicity / trademark review before
 * promotion on a HOST surface? (A recognizable person, a brand/logo, a missing model
 * release, or a trademark.) This does NOT change the posture — it gates promotion.
 * @param {LicenseTag} tag
 * @returns {boolean}
 */
export function needsRightsReview(tag) {
  const flags = tag && Array.isArray(tag.flags) ? tag.flags : [];
  return flags.some((f) => REVIEW_FLAGS.has(f));
}

export default { POSTURE, HOST_FAMILIES, REVIEW_FLAGS, routeLicense, needsRightsReview };
