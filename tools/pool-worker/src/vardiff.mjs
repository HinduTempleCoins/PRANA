// vardiff.mjs (PR9) — per-worker variable difficulty.
//
// Spec: design/compute/switching-worker.md §4. Vardiff keeps both small and large units
// competitive by tuning each worker's share difficulty so it submits at a STEADY cadence
// (target ~1 share / N seconds) regardless of hashrate. The chain stores only governed
// BOUNDS (HashTaskWeightConfig.min/maxDifficulty); the MATH is off-chain — this file.
//
// Standard pool vardiff: track recent inter-share solve times; shares too fast -> raise
// the difficulty target; too slow -> lower it; clamp to [min,max]; damp to avoid
// oscillation.
//
// REAL: this is genuine, deterministic vardiff math — fully unit-testable. The only thing
// stubbed elsewhere is the hashing that *produces* the solve times (hash-lane.mjs).
//
// Note on "difficulty" direction: higher difficulty -> rarer share -> LONGER expected
// solve time. So to make shares come slower we RAISE difficulty; to make them come faster
// we LOWER difficulty. We model expected solve time as proportional to difficulty for a
// fixed hashrate: t ≈ difficulty / hashrate. The controller nudges difficulty toward the
// value that yields the target cadence.

/**
 * Pure adjustment step. Given the current difficulty and the observed solve time of the
 * last share (seconds), return the next difficulty that moves observed cadence toward the
 * target. Clamped to [min,max] and damped by `damping`.
 *
 * Ratio logic: idealDiff = currentDiff * (targetSeconds / observedSeconds). If shares are
 * too fast (observed < target), ratio > 1 -> raise difficulty. Too slow -> lower it. We
 * apply only a fraction (`damping`) of the move each step to converge smoothly.
 *
 * @param {object} p
 * @param {number} p.currentDifficulty current per-worker difficulty (> 0)
 * @param {number} p.observedSeconds   measured inter-share time for the last share (> 0)
 * @param {number} p.targetSeconds     desired seconds per share (> 0)
 * @param {number} p.minDifficulty     governed floor (anti-spam)
 * @param {number} p.maxDifficulty     governed ceiling (so small units still land shares)
 * @param {number} [p.damping]         0..1 fraction of the ideal move to apply (default 0.5)
 * @returns {number} next difficulty, clamped
 */
export function adjustDifficulty({
  currentDifficulty,
  observedSeconds,
  targetSeconds,
  minDifficulty,
  maxDifficulty,
  damping = 0.5,
}) {
  if (!(currentDifficulty > 0)) throw new Error('vardiff: currentDifficulty must be > 0');
  if (!(observedSeconds > 0)) throw new Error('vardiff: observedSeconds must be > 0');
  if (!(targetSeconds > 0)) throw new Error('vardiff: targetSeconds must be > 0');
  if (minDifficulty <= 0 || maxDifficulty < minDifficulty) {
    throw new Error('vardiff: require 0 < minDifficulty <= maxDifficulty');
  }
  const d = clamp01(damping);

  // ideal difficulty that would have produced exactly targetSeconds for this share.
  const ideal = currentDifficulty * (targetSeconds / observedSeconds);

  // damped move toward ideal (exponential-ish approach; avoids oscillation).
  const next = currentDifficulty + (ideal - currentDifficulty) * d;

  return clamp(next, minDifficulty, maxDifficulty);
}

/**
 * Stateful controller wrapping adjustDifficulty. Holds the current difficulty and exposes
 * observe(solveSeconds) -> newDifficulty. Smooths over a small window of solve times so a
 * single fast/slow share doesn't whipsaw the target.
 */
export class VardiffController {
  /**
   * @param {object} opts
   * @param {number} opts.targetSeconds
   * @param {number} opts.minDifficulty
   * @param {number} opts.maxDifficulty
   * @param {number} [opts.initialDifficulty]
   * @param {number} [opts.damping]        default 0.5
   * @param {number} [opts.window]         # of recent solve times averaged (default 4)
   */
  constructor({
    targetSeconds,
    minDifficulty,
    maxDifficulty,
    initialDifficulty,
    damping = 0.5,
    window = 4,
  }) {
    if (minDifficulty <= 0 || maxDifficulty < minDifficulty) {
      throw new Error('VardiffController: require 0 < minDifficulty <= maxDifficulty');
    }
    this.targetSeconds = targetSeconds;
    this.minDifficulty = minDifficulty;
    this.maxDifficulty = maxDifficulty;
    this.damping = clamp01(damping);
    this.window = Math.max(1, Math.floor(window));
    this.difficulty = clamp(
      initialDifficulty ?? Math.sqrt(minDifficulty * maxDifficulty), // geometric midpoint
      minDifficulty,
      maxDifficulty,
    );
    /** @type {number[]} recent solve times (seconds) */
    this._recent = [];
  }

  /** Current clamped difficulty (what the hasher should mine against). */
  currentTarget() {
    return this.difficulty;
  }

  /**
   * Feed an observed solve time; returns the updated difficulty.
   * @param {number} solveSeconds time since the last accepted share (> 0)
   */
  observe(solveSeconds) {
    if (!(solveSeconds > 0)) throw new Error('VardiffController.observe: solveSeconds must be > 0');
    this._recent.push(solveSeconds);
    if (this._recent.length > this.window) this._recent.shift();
    const avg = this._recent.reduce((a, b) => a + b, 0) / this._recent.length;

    this.difficulty = adjustDifficulty({
      currentDifficulty: this.difficulty,
      observedSeconds: avg,
      targetSeconds: this.targetSeconds,
      minDifficulty: this.minDifficulty,
      maxDifficulty: this.maxDifficulty,
      damping: this.damping,
    });
    return this.difficulty;
  }
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
function clamp01(x) {
  return clamp(x, 0, 1);
}
