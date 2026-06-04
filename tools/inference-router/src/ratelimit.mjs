// @prana/inference-router — tiny token-bucket rate limiter (TASK XX19)
//
// Each free-tier backend gets one TokenBucket so the router respects the
// provider's published limits and doesn't get the whole swarm banned. This is a
// classic token bucket:
//   - `capacity`  : max tokens (the burst allowance)
//   - `refillPerSec` : tokens regenerated each second (the steady-state rate)
// A request `tryRemove(n)` succeeds only if >= n tokens are available, removing
// them; otherwise it fails and the router treats the backend as ratelimited.
//
// Time is injectable (`now`) so tests are deterministic — no real clock, no
// timers, fully UNIT TESTABLE.

export class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity        max tokens (burst size). > 0.
   * @param {number} opts.refillPerSec    tokens added per second. >= 0.
   * @param {number} [opts.tokens]        starting tokens (default: full).
   * @param {() => number} [opts.now]     ms clock; default Date.now. Inject in tests.
   */
  constructor({ capacity, refillPerSec, tokens, now = Date.now } = {}) {
    if (!(capacity > 0)) throw new Error('TokenBucket: capacity must be > 0');
    if (!(refillPerSec >= 0)) throw new Error('TokenBucket: refillPerSec must be >= 0');
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this._now = now;
    this.tokens = tokens === undefined ? capacity : Math.min(tokens, capacity);
    this.last = this._now();
  }

  /** Refill tokens based on elapsed wall-time since the last touch. Idempotent. */
  _refill() {
    const t = this._now();
    const elapsedSec = Math.max(0, (t - this.last) / 1000);
    if (elapsedSec > 0 && this.refillPerSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    }
    this.last = t;
  }

  /** Current token count after refilling. Mostly for tests/observability. */
  available() {
    this._refill();
    return this.tokens;
  }

  /**
   * Try to consume `n` tokens. Returns true and removes them if available,
   * false (and removes nothing) if not.
   * @param {number} [n=1]
   * @returns {boolean}
   */
  tryRemove(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}
