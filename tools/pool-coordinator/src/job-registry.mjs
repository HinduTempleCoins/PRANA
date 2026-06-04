// job-registry.mjs — track available AI jobs + DEDUP. PURE state machine, UNIT-TESTABLE.
//
// Spec: coordinator.md §1 (`task-dispatch`: assign tasks, REDUNDANT K copies) + the on-chain
// JobClaimLedger (PR2 / §14) which is "the single chain-wide arbiter of who claimed which job
// first so a job becomes pooled shares at most once across the WHOLE network."
//
// This module is the coordinator's LOCAL mirror of that ledger's lifecycle:
//   addJob(job)              register an available AI job (id keyed by spec hash + nonce).
//   claimJob(jobId, worker)  first worker to claim wins; a second claim of an open/settled job
//                            is rejected (mirrors JobClaimLedger.claim → AlreadyClaimed).
//   settleJob(jobId)         mark the claim final (the share was credited); never re-claimable
//                            (mirrors JobClaimLedger.settle → terminal).
//   releaseJob(jobId)        a dropped (claimed-but-unsettled) claim past the window frees the
//                            job to be claimed again (mirrors JobClaimLedger.release).
//
// WHY a local mirror AND an on-chain ledger: the local mirror is the hot path (instant dedup
// inside this coordinator); the on-chain JobClaimLedger is the cross-coordinator arbiter the
// settler ALSO calls before crediting, so two different coordinators can't double-credit the
// same job (coordinator.md §7 q3). The local mirror's claim() keys/return values are shaped to
// feed straight into the on-chain claim(jobId, worker).
//
// REAL vs STUB: the dedup state machine + windowed release are REAL. Job *content* (the actual
// AI prompt/model/inputs) is opaque here — the coordinator only needs the id + redundancy.

const STATUS = Object.freeze({ OPEN: 'open', CLAIMED: 'claimed', SETTLED: 'settled' });

export class JobRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.claimWindowMs=60000] ms after which an unsettled claim is releasable
   *   by the registry (mirrors JobClaimLedger.claimWindow).
   * @param {number} [opts.redundancy=1] K copies of each job to hand out (coordinator.md §1).
   * @param {() => number} [opts.now=Date.now] injectable clock for deterministic tests.
   */
  constructor(opts = {}) {
    this.claimWindowMs = opts.claimWindowMs ?? 60_000;
    this.redundancy = opts.redundancy ?? 1;
    this._now = opts.now ?? Date.now;
    /** @type {Map<string, {jobId, spec, status, claimant, claimedAt, copies}>} */
    this._jobs = new Map();
  }

  /**
   * Register an available job. `jobId` should be the on-chain key (keccak of normalized spec +
   * nonce); the caller supplies it so identical work hashes the same across coordinators.
   * @returns {{ok:true, jobId}|{ok:false, reason}}
   */
  addJob({ jobId, spec = null, copies = this.redundancy }) {
    if (!isBytes32(jobId)) return { ok: false, reason: 'bad-jobId' };
    if (this._jobs.has(jobId)) return { ok: false, reason: 'job-exists' };
    this._jobs.set(jobId, {
      jobId,
      spec,
      status: STATUS.OPEN,
      claimant: null,
      claimedAt: 0,
      copies: Math.max(1, copies | 0),
    });
    return { ok: true, jobId };
  }

  /**
   * The next claimable job for a worker pulling work (GET /job). Returns an OPEN job the worker
   * hasn't already claimed. Does NOT mutate — call claimJob to actually take it.
   * @returns {{jobId, spec}|null}
   */
  nextOpenJob() {
    for (const j of this._jobs.values()) {
      // lazily free dropped claims so they become handable again.
      this._maybeAutoRelease(j);
      if (j.status === STATUS.OPEN) return { jobId: j.jobId, spec: j.spec };
    }
    return null;
  }

  /**
   * Claim a job for a worker. First claim wins; double-claim of a claimed/settled job rejects.
   * Mirrors JobClaimLedger.claim() — the dedup primitive.
   * @returns {{ok:true, jobId, worker}|{ok:false, reason}}
   */
  claimJob(jobId, worker) {
    const j = this._jobs.get(jobId);
    if (!j) return { ok: false, reason: 'unknown-job' };
    this._maybeAutoRelease(j);
    if (j.status === STATUS.SETTLED) return { ok: false, reason: 'already-settled' };
    if (j.status === STATUS.CLAIMED) return { ok: false, reason: 'already-claimed' };
    if (!isAddress(worker)) return { ok: false, reason: 'bad-worker' };

    j.status = STATUS.CLAIMED;
    j.claimant = worker;
    j.claimedAt = this._now();
    return { ok: true, jobId, worker };
  }

  /**
   * Finalize a claimed job (its share was credited). Terminal — never re-claimable.
   * Mirrors JobClaimLedger.settle().
   * @returns {{ok:true}|{ok:false, reason}}
   */
  settleJob(jobId) {
    const j = this._jobs.get(jobId);
    if (!j) return { ok: false, reason: 'unknown-job' };
    if (j.status === STATUS.SETTLED) return { ok: false, reason: 'already-settled' };
    if (j.status !== STATUS.CLAIMED) return { ok: false, reason: 'not-claimed' };
    j.status = STATUS.SETTLED;
    return { ok: true };
  }

  /**
   * Release a claimed-but-unsettled job so it's claimable again. The claimant may release any
   * time; anyone else only after the claim window. Mirrors JobClaimLedger.release().
   * @returns {{ok:true}|{ok:false, reason}}
   */
  releaseJob(jobId, { by = null } = {}) {
    const j = this._jobs.get(jobId);
    if (!j) return { ok: false, reason: 'unknown-job' };
    if (j.status === STATUS.SETTLED) return { ok: false, reason: 'already-settled' };
    if (j.status !== STATUS.CLAIMED) return { ok: false, reason: 'not-claimed' };
    const isClaimant = by != null && by === j.claimant;
    if (!isClaimant && this._now() < j.claimedAt + this.claimWindowMs) {
      return { ok: false, reason: 'claim-window-not-elapsed' };
    }
    j.status = STATUS.OPEN;
    j.claimant = null;
    j.claimedAt = 0;
    return { ok: true };
  }

  /** Auto-release a claimed job whose window elapsed (lazy, called on read paths). */
  _maybeAutoRelease(j) {
    if (j.status === STATUS.CLAIMED && this._now() >= j.claimedAt + this.claimWindowMs) {
      j.status = STATUS.OPEN;
      j.claimant = null;
      j.claimedAt = 0;
    }
  }

  /** @returns {boolean} true if the job exists and is currently claimed or settled. */
  isClaimed(jobId) {
    const j = this._jobs.get(jobId);
    return !!j && (j.status === STATUS.CLAIMED || j.status === STATUS.SETTLED);
  }

  statusOf(jobId) {
    return this._jobs.get(jobId)?.status ?? null;
  }

  /** Counts by status for /stats. */
  counts() {
    let open = 0,
      claimed = 0,
      settled = 0;
    for (const j of this._jobs.values()) {
      if (j.status === STATUS.OPEN) open++;
      else if (j.status === STATUS.CLAIMED) claimed++;
      else settled++;
    }
    return { open, claimed, settled, total: this._jobs.size };
  }
}

export { STATUS as JOB_STATUS };

// ----------------------------- helpers -----------------------------

function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isBytes32(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}
