// hash-lane.mjs — STUB microhash (Etchash heartbeat) loop.
//
// Spec: design/compute/switching-worker.md §1 (`hasher`) + §4. The REAL daemon mines an
// Etchash microhash share against a per-connection vardiff target and submits the share to
// the coordinator, which re-validates the PoW and normalizes it to an equal-weight unit
// (HashLaneCreditor: "vardiff-normalized share counts off-chain").
//
// WHAT IS STUBBED: there is NO real Ethash/Etchash/CUDA here. mineOne() synthesizes a
// share whose "solve time" is derived deterministically from the difficulty and the
// declared hashPower, so the vardiff controller can converge on a steady cadence in tests
// and dev runs. The share SHAPE (what we hand the coordinator) is real: one accepted share
// == one normalized HASH-lane unit after the coordinator normalizes (HashLaneCreditor
// submitBatch hashShares[] entry).
//
// REAL: the share object shape + the solve-time<->difficulty relationship vardiff relies on.
// STUB: the proof-of-work itself.

/**
 * Synthesize one microhash share for the current difficulty.
 *
 * Model: expected solve time t ≈ difficulty / hashrate. We treat hashrate as a stable
 * per-unit constant (hashPower scaled) so that raising difficulty lengthens solve time —
 * exactly the lever vardiff pulls. A small deterministic jitter avoids a perfectly flat
 * signal without introducing nondeterminism that would flake tests (jitter is seedable).
 *
 * @param {object} p
 * @param {number} p.difficulty current vardiff target (> 0)
 * @param {number} p.hashPower  coarse 0..N unit-speed hint (from hardware.mjs)
 * @param {string} p.workerAddr beacon-bound payout address (keys the share)
 * @param {number} [p.jitter]   0..1 deterministic jitter fraction (default 0)
 * @returns {{worker:string, lane:'HASH', difficulty:number, solveSeconds:number, meetsTarget:boolean, nonce:string}}
 */
export function mineOne({ difficulty, hashPower, workerAddr, jitter = 0 }) {
  if (!(difficulty > 0)) throw new Error('hash-lane: difficulty must be > 0');
  // hashrate floor so a near-zero hashPower CPU still produces (slow) shares.
  const hashrate = Math.max(0.001, hashPower);
  const base = difficulty / hashrate; // seconds (synthetic)
  const solveSeconds = base * (1 + jitter); // jitter in [0,1) lengthens slightly

  return {
    worker: workerAddr,
    lane: 'HASH', // mirrors IUnifiedSharesLedger.Lane.HASH
    difficulty,
    solveSeconds,
    // In this stub every produced share meets target (we already mined to `difficulty`).
    // A real miner would compare hash < target; coordinator re-validates regardless.
    meetsTarget: true,
    nonce: synthNonce(workerAddr, difficulty, solveSeconds),
  };
}

/**
 * Build the per-worker payload the coordinator turns into a HASH-lane share submission.
 * The coordinator (SS2) accumulates these and, at epoch close, calls
 * HashLaneCreditor.submitBatch(epoch, batchId, workers[], hashShares[]). One accepted
 * share contributes one normalized unit -> hashShares[i] gets +1 for this worker.
 *
 * @param {ReturnType<typeof mineOne>} share
 * @returns {{type:'hashShare', worker:string, lane:'HASH', difficulty:number, nonce:string, units:number}}
 */
export function toSubmission(share) {
  return {
    type: 'hashShare',
    worker: share.worker,
    lane: 'HASH',
    difficulty: share.difficulty,
    nonce: share.nonce,
    units: 1, // coordinator normalizes; one accepted share == one equal-weight unit
  };
}

function synthNonce(addr, difficulty, t) {
  // deterministic, non-cryptographic — STUB only.
  const s = `${addr}:${difficulty}:${t}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return '0x' + h.toString(16).padStart(8, '0');
}
