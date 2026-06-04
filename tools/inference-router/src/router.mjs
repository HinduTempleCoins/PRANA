// @prana/inference-router — the fallthrough router (TASK XX19)
//
// "Hathor pulls from whichever nodes are live." Given a list of backend
// descriptors (see backends.mjs), the router:
//   1. sorts them by `priority` ascending — the LADDER:
//        river (cheapest/aligned)  <  free-api (free, limited)  <  cloud (paid).
//   2. walks the ladder; for each backend it:
//        a. skips it if its token bucket is empty (RATELIMITED),
//        b. skips it if healthCheck() is false / throws (UNHEALTHY),
//        c. calls infer(prompt); on throw, records the FAILURE and falls through,
//        d. on success, returns immediately with which backend served it.
//   3. if every backend is exhausted, throws an AggregateError with the trail.
//
// Backends are INJECTED (constructor arg), so this is fully UNIT TESTABLE with
// stub backends — no network, no real models.

/** @typedef {import('./backends.mjs').makeRiverBackend} Backend */

export class InferenceRouter {
  /**
   * @param {Array} backends  array of backend descriptors
   *   ({ name, kind, priority, healthCheck(), infer(prompt), bucket? }).
   * @param {object} [opts]
   * @param {(event: object) => void} [opts.onAttempt]  observability hook,
   *   called for each backend attempt with { backend, kind, outcome, error? }.
   */
  constructor(backends, opts = {}) {
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new Error('InferenceRouter: need at least one backend');
    }
    // Stable sort by priority ascending (lower = tried first). Preserve original
    // order for equal priorities.
    this.backends = backends
      .map((b, i) => ({ b, i }))
      .sort((a, z) => a.b.priority - z.b.priority || a.i - z.i)
      .map(({ b }) => b);
    this.onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : () => {};
  }

  _emit(backend, outcome, error) {
    this.onAttempt({ backend: backend.name, kind: backend.kind, outcome, error });
  }

  /**
   * Route one prompt down the ladder. Returns the first success.
   * @param {string} prompt
   * @param {object} [opts]
   * @param {number} [opts.cost=1]  token-bucket cost charged per attempt.
   * @returns {Promise<{ text:string, servedBy:string, kind:string, attempts:Array }>}
   */
  async infer(prompt, opts = {}) {
    const cost = opts.cost ?? 1;
    const attempts = []; // trail of what we tried, for debugging + the error.

    for (const backend of this.backends) {
      // (a) RATELIMIT gate — only if the backend carries a bucket.
      if (backend.bucket && !backend.bucket.tryRemove(cost)) {
        attempts.push({ backend: backend.name, outcome: 'ratelimited' });
        this._emit(backend, 'ratelimited');
        continue; // fall through to the next backend on the ladder.
      }

      // (b) HEALTH gate. A throwing healthCheck is treated as unhealthy.
      let healthy = false;
      try {
        healthy = await backend.healthCheck();
      } catch (err) {
        attempts.push({ backend: backend.name, outcome: 'unhealthy', error: String(err) });
        this._emit(backend, 'unhealthy', err);
        continue;
      }
      if (!healthy) {
        attempts.push({ backend: backend.name, outcome: 'unhealthy' });
        this._emit(backend, 'unhealthy');
        continue;
      }

      // (c) ATTEMPT inference. On failure, record and fall through.
      try {
        const out = await backend.infer(prompt);
        attempts.push({ backend: backend.name, outcome: 'success' });
        this._emit(backend, 'success');
        return {
          ...out,
          servedBy: backend.name,
          kind: backend.kind,
          attempts,
        };
      } catch (err) {
        attempts.push({ backend: backend.name, outcome: 'failed', error: String(err) });
        this._emit(backend, 'failed', err);
        // fall through to the next backend.
      }
    }

    // (3) Exhausted the whole ladder.
    const err = new AggregateError(
      attempts.map((a) => new Error(`${a.backend}: ${a.outcome}`)),
      'InferenceRouter: all backends exhausted',
    );
    err.attempts = attempts;
    throw err;
  }
}

/** Convenience factory. */
export function createRouter(backends, opts) {
  return new InferenceRouter(backends, opts);
}
