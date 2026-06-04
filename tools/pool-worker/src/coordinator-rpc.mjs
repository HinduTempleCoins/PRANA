// coordinator-rpc.mjs — the ONLY write path to the coordinator (SS2 API).
//
// Spec: design/compute/coordinator.md §2 share-collection API; switching-worker.md §1
// boundary rule ("coordinator-rpc is the only mutating egress; the daemon NEVER holds a
// CREDITOR_ROLE key and NEVER calls creditShares directly"). The worker submits shares; the
// coordinator re-validates, normalizes, batches, and settles on-chain.
//
// Transport: a tiny JSON-over-HTTP client using built-in fetch (no ws/deps). Methods mirror
// the spec's stratum-like surface: getWork / submitHashShare / tryClaimTask /
// submitTaskResult / heartbeat. Each call POSTs {method, params} to the coordinator URL.
//
// REAL: the method surface + payload shapes (worker-keyed, lane-tagged, matching the
//       creditor contracts). STUB-friendly: a `fetchImpl` is injectable so index/tests run
//       offline. Network failures are caught and surfaced as {ok:false} so the loop can
//       back off (switching-worker.md §7: never spin on dead RPC).

export class CoordinatorClient {
  /**
   * @param {object} opts
   * @param {string} opts.url      coordinator base URL
   * @param {string} opts.workerAddr beacon-bound payout address
   * @param {string} opts.workerId
   * @param {typeof fetch} [opts.fetchImpl] injectable (default global fetch)
   * @param {number} [opts.timeoutMs] per-request timeout (default 5000)
   */
  constructor({ url, workerAddr, workerId, fetchImpl, timeoutMs = 5000 }) {
    this.url = url.replace(/\/+$/, '');
    this.workerAddr = workerAddr;
    this.workerId = workerId;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  /** getWork: current hash job + vardiff target + enabled task-types/priorities. */
  getWork() {
    return this._call('getWork', { worker: this.workerAddr });
  }

  /** submitHashShare: a (stubbed) PoW share; coordinator re-validates + normalizes. */
  submitHashShare(submission) {
    return this._call('submitHashShare', submission);
  }

  /**
   * tryClaimTask: non-blocking — returns a task this unit can run, or null. The coordinator
   * filters by capability + on-chain ITaskRegistry enabled/priority (Hathor first).
   * @param {{canHash:boolean,canTask:boolean}} cap
   */
  tryClaimTask(cap) {
    return this._call('tryClaimTask', { worker: this.workerAddr, cap });
  }

  /** submitTaskResult: result + attestation material; coordinator opens the gate claim. */
  submitTaskResult(submission) {
    return this._call('submitTaskResult', submission);
  }

  /** heartbeat: liveness for the machine-count metric + beacon freshness. */
  heartbeat() {
    return this._call('heartbeat', { worker: this.workerAddr, workerId: this.workerId });
  }

  /**
   * Low-level JSON-RPC-ish POST. Returns {ok, data} or {ok:false, error} — never throws on
   * network failure, so the daemon loop can back off cleanly.
   */
  async _call(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    // unref so a pending request can never keep the process alive in tests/shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this._fetch(`${this.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      const data = await res.json().catch(() => ({}));
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
