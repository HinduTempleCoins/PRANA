// share-validator.mjs — validate a worker-submitted share. PURE + UNIT-TESTABLE.
//
// Spec: coordinator.md §1 (`pow-validate`: "re-verify every Etchash share; clients are
// untrusted") and §3.2 (TASK shares require a K-of-N verified attestation before they can
// become pooled shares — a forged task share is worth a real hash share, so it must clear
// the gate). This module encodes the OFF-CHAIN validation the coordinator does before it
// will ever credit a share into the ledger.
//
// TWO LANES, TWO TRUST MODELS (from the contracts):
//   HASH lane (HashLaneCreditor): self-verifying. A PoW share is self-evidently work; the
//     coordinator re-checks the proof against the advertised difficulty and accepts. No
//     attestation needed (HashLaneCreditor NatSpec: "a hash share is self-evidently work").
//   TASK lane (TaskLaneCreditor → TaskVerificationGate): NOT self-verifying. The result must
//     carry a K-of-N attestation payload; the coordinator checks the K-of-N *shape* here and
//     (in prod) routes it into TaskVerificationGate.openClaim + attest×K before crediting.
//
// REAL vs STUB (honest):
//   - REAL: the lane routing, the field/shape checks, difficulty comparison, K-of-N counting,
//     dedup-friendly normalized output. All deterministic + unit-tested.
//   - STUB: the actual Etchash/Keccak PoW verification is replaced by a SYNTHETIC proof check
//     (`proof === expectedSyntheticProof(workerId, nonce, difficulty)`), and attestor signature
//     verification is replaced by counting well-formed attestor entries. Real crypto slots in
//     here without changing the interface. Stubs are commented as such.

/** Canonical lane strings the worker uses (matches worker submit shape {lane}). */
export const LANES = Object.freeze(['hash', 'task']);

/**
 * The synthetic "PoW proof" a HASH share must carry in the skeleton. In production this is
 * replaced by real Etchash verification (mix-digest + final hash <= target). Here it is a
 * deterministic function of the share inputs so a test can produce a valid/invalid proof.
 * STUB — not real proof-of-work.
 * @param {string} workerId
 * @param {number|string} nonce
 * @param {number} difficulty
 */
export function expectedSyntheticProof(workerId, nonce, difficulty) {
  // FNV-1a-ish fold of the inputs → hex string. Cheap, deterministic, dependency-free.
  let h = 0x811c9dc5 >>> 0;
  const s = `${workerId}|${nonce}|${difficulty}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0x${h.toString(16).padStart(8, '0')}`;
}

/**
 * Validate a submitted share.
 * @param {object} share - the decoded POST /submit-share body.
 *   { workerId, account, lane:'hash'|'task', difficulty, proof?, nonce?, result?, attestation? }
 *   `account` is the beacon-bound payout address ALL credit is keyed to (coordinator.md §2).
 * @param {object} [opts]
 * @param {number} [opts.minDifficulty=1] reject shares below the coordinator's vardiff floor.
 * @param {number} [opts.attestK] required K (defaults from N if omitted; caller passes cfg).
 * @param {number} [opts.attestN] attestor-set size.
 * @returns {{ok:true, lane, account, units, normalized}|{ok:false, reason}}
 *   `units` = equal-weight share units to accumulate (vardiff-normalized: difficulty/minDiff).
 */
export function validateShare(share, opts = {}) {
  const minDifficulty = opts.minDifficulty ?? 1;

  if (!share || typeof share !== 'object') return fail('share-not-object');

  const lane = String(share.lane || '').toLowerCase();
  if (!LANES.includes(lane)) return fail(`bad-lane:${lane || '(none)'}`);

  const account = share.account ?? share.workerAddr;
  if (!isAddress(account)) return fail('bad-account');

  if (typeof share.workerId !== 'string' || share.workerId.length === 0) {
    return fail('bad-workerId');
  }

  const difficulty = Number(share.difficulty);
  if (!Number.isFinite(difficulty) || difficulty <= 0) return fail('bad-difficulty');
  if (difficulty < minDifficulty) return fail('below-min-difficulty');

  // vardiff normalization: every accepted share is worth difficulty/minDifficulty equal-weight
  // units, so a worker on a high target and one on a low target are credited proportionally
  // (HashLaneCreditor expects "already-normalized" units — coordinator.md §1 vardiff).
  const units = difficulty / minDifficulty;

  if (lane === 'hash') {
    // STUB: synthetic PoW check. Real Etchash verification slots in here unchanged.
    const nonce = share.nonce ?? 0;
    const expect = expectedSyntheticProof(share.workerId, nonce, difficulty);
    if (share.proof !== expect) return fail('bad-pow-proof');
    return { ok: true, lane, account, units, normalized: round(units) };
  }

  // lane === 'task': must carry a result + a K-of-N attestation payload.
  if (share.result == null || share.result === '') return fail('missing-task-result');
  const att = share.attestation;
  const shape = checkAttestationShape(att, { attestK: opts.attestK, attestN: opts.attestN });
  if (!shape.ok) return shape;
  return { ok: true, lane, account, units, normalized: round(units), claimId: shape.claimId };
}

/**
 * Check the K-of-N attestation SHAPE for a TASK share. PURE + UNIT-TESTABLE.
 * STUB: counts well-formed attestor entries marked verified; production verifies each
 * attestor's signature/stake via TaskVerificationGate. The K-of-N *shape* check is real.
 * @param {object} att - { claimId, k, n, attestors:[{addr, verified}] }
 * @param {object} [bounds] - { attestK, attestN } coordinator-required bounds (optional).
 * @returns {{ok:true, claimId, k, n, verifiedCount}|{ok:false, reason}}
 */
export function checkAttestationShape(att, bounds = {}) {
  if (!att || typeof att !== 'object') return fail('attestation-not-object');
  if (!isBytes32(att.claimId)) return fail('bad-claimId');

  const k = Number(att.k);
  const n = Number(att.n);
  if (!Number.isInteger(k) || !Number.isInteger(n)) return fail('bad-kn-types');
  if (k <= 0 || n <= 0 || k > n) return fail('bad-kn-range');

  if (!Array.isArray(att.attestors) || att.attestors.length !== n) {
    return fail('attestor-count-mismatch');
  }

  // each attestor must be a distinct address; count those marked verified (STUB for real
  // signature/stake checks done in TaskVerificationGate.attest()).
  const seen = new Set();
  let verifiedCount = 0;
  for (const a of att.attestors) {
    if (!a || !isAddress(a.addr)) return fail('bad-attestor-addr');
    const low = a.addr.toLowerCase();
    if (seen.has(low)) return fail('duplicate-attestor');
    seen.add(low);
    if (a.verified === true) verifiedCount++;
  }

  if (verifiedCount < k) return fail(`quorum-not-met:${verifiedCount}/${k}`);

  // optional: enforce the coordinator's own configured K-of-N bounds if supplied.
  if (bounds.attestK != null && k < bounds.attestK) return fail('k-below-coordinator-min');
  if (bounds.attestN != null && n > bounds.attestN) return fail('n-above-coordinator-max');

  return { ok: true, claimId: att.claimId, k, n, verifiedCount };
}

// ----------------------------- helpers -----------------------------

function fail(reason) {
  return { ok: false, reason };
}
function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isBytes32(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}
function round(x) {
  // integer equal-weight units (the ledger credits uint share counts); floor, min 1.
  return Math.max(1, Math.floor(x));
}
