// epoch-batcher.mjs — accumulate validated shares per (account, lane) and, at epoch close,
// produce the on-chain batch. PURE AGGREGATION, UNIT-TESTABLE.
//
// Spec: coordinator.md §3. The coordinator keeps an in-memory accumulator
//   epoch → account → { hashUnits, taskClaims } (coordinator.md §2)
// and, at/after epoch close, emits the settlement payloads:
//   HASH lane → HashLaneCreditor.submitBatch(epoch, batchId, workers[], normalizedHashUnits[])
//   TASK lane → per verified completion: TaskLaneCreditor.creditVerified(claimId, taskId, base)
//
// Epoch math MUST match the chain (EpochManager): epoch = floor(ts / epochLength); an epoch is
// CLOSED when now >= (epoch+1)*epochLength. We compute epochs in SECONDS to mirror the contract.
//
// Epoch-accounting nuance (coordinator.md §3, from HashLaneCreditor NatSpec): the ledger's
// creditShares() always credits the ledger's CURRENT epoch; the `epoch` arg on submitBatch is
// the coordinator's accounting/replay key, NOT a re-bucket. So the batcher fires at epoch close
// (before the next epoch's accounting drifts) and tags the batch with the epoch it accounts for.
//
// This module does ZERO I/O and never sends a tx — it only produces the data the settler signs.

export class EpochBatcher {
  /**
   * @param {object} opts
   * @param {number} opts.epochLengthSeconds  must equal the on-chain ledger's epochLength.
   * @param {string} opts.coordinatorId        mixed into batchId (coordinator.md §3.1).
   */
  constructor({ epochLengthSeconds, coordinatorId }) {
    if (!(epochLengthSeconds > 0)) throw new Error('epoch-batcher: epochLengthSeconds must be > 0');
    this.epochLengthSeconds = epochLengthSeconds;
    this.coordinatorId = coordinatorId || 'coord';
    /** epoch(number) → Map<account, {hashUnits, taskItems:[{claimId,taskId,baseShares}]}> */
    this._acc = new Map();
    /** per-epoch HASH batch sequence (for unique batchId across split batches). */
    this._seq = new Map();
  }

  /** epoch number for a unix-seconds timestamp (mirrors EpochManager.epochAt). */
  epochAt(tsSeconds) {
    return Math.floor(tsSeconds / this.epochLengthSeconds);
  }

  /** true once `now` has passed the END of `epoch` (mirrors EpochManager.isEpochClosed). */
  isEpochClosed(epoch, nowSeconds) {
    return nowSeconds >= (epoch + 1) * this.epochLengthSeconds;
  }

  /**
   * Add a validated HASH share's normalized units to (epoch, account).
   * @param {object} v - validated share: { account, normalized } (from validateShare, lane=hash).
   * @param {number} tsSeconds - submission time (defaults to now).
   */
  addHashShare(v, tsSeconds = nowSec()) {
    const epoch = this.epochAt(tsSeconds);
    const bucket = this._bucket(epoch, v.account);
    bucket.hashUnits += v.normalized;
  }

  /**
   * Add a verified TASK completion to (epoch, account). TASK credit is per-completion (it
   * straddles epochs because verification is async — coordinator.md §3.2), so we record the
   * claim items to be settled via creditVerified, keyed under the epoch they landed in.
   * @param {object} item - { account, claimId, taskId, baseShares }
   */
  addTaskCompletion(item, tsSeconds = nowSec()) {
    const epoch = this.epochAt(tsSeconds);
    const bucket = this._bucket(epoch, item.account);
    bucket.taskItems.push({
      claimId: item.claimId,
      taskId: item.taskId,
      baseShares: item.baseShares ?? 1,
    });
  }

  /**
   * Produce the settlement payload for a CLOSED epoch (idempotent read of the accumulator;
   * does not clear — call drainEpoch() once the settler confirms, so a retry can re-read).
   *
   * @param {number} epoch
   * @param {object} [opts]
   * @param {number} [opts.maxWorkersPerBatch=200] split HASH workers into gas-bounded batches
   *   (coordinator.md §3.1: "Large worker sets are split across multiple batchIds").
   * @returns {{epoch, hashBatches:Array<{batchId,workers,hashShares,total}>,
   *            taskCredits:Array<{account,claimId,taskId,baseShares}>}}
   */
  buildEpochBatch(epoch, opts = {}) {
    const max = opts.maxWorkersPerBatch ?? 200;
    const accounts = this._acc.get(epoch) ?? new Map();

    // ---- HASH lane: one or more submitBatch payloads ----
    const hashWorkers = [];
    for (const [account, b] of accounts) {
      if (b.hashUnits > 0) hashWorkers.push([account, Math.floor(b.hashUnits)]);
    }
    // deterministic order so batchIds are stable across retries.
    hashWorkers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const hashBatches = [];
    let seq = this._seq.get(epoch) ?? 0;
    for (let i = 0; i < hashWorkers.length; i += max) {
      const slice = hashWorkers.slice(i, i + max);
      const workers = slice.map((w) => w[0]);
      const hashShares = slice.map((w) => w[1]);
      const total = hashShares.reduce((s, x) => s + x, 0);
      hashBatches.push({
        batchId: this._batchId(epoch, seq),
        workers,
        hashShares,
        total,
      });
      seq++;
    }

    // ---- TASK lane: one creditVerified per completion ----
    const taskCredits = [];
    for (const [account, b] of accounts) {
      for (const t of b.taskItems) {
        taskCredits.push({ account, claimId: t.claimId, taskId: t.taskId, baseShares: t.baseShares });
      }
    }

    return { epoch, hashBatches, taskCredits };
  }

  /** Clear an epoch's accumulator after the settler confirms it's posted. Advances batch seq. */
  drainEpoch(epoch) {
    const accounts = this._acc.get(epoch);
    if (!accounts) return;
    // remember how many hash batches we minted so a later re-add wouldn't reuse batchIds.
    const hashWorkerCount = [...accounts.values()].filter((b) => b.hashUnits > 0).length;
    const prevSeq = this._seq.get(epoch) ?? 0;
    this._seq.set(epoch, prevSeq + Math.max(1, hashWorkerCount));
    this._acc.delete(epoch);
  }

  /** Epochs currently holding un-drained shares, ascending. */
  pendingEpochs() {
    return [...this._acc.keys()].sort((a, b) => a - b);
  }

  /** Closed epochs ready to settle given `nowSeconds`. */
  closedPendingEpochs(nowSeconds = nowSec()) {
    return this.pendingEpochs().filter((e) => this.isEpochClosed(e, nowSeconds));
  }

  // ----------------------------- internals -----------------------------

  _bucket(epoch, account) {
    let accounts = this._acc.get(epoch);
    if (!accounts) {
      accounts = new Map();
      this._acc.set(epoch, accounts);
    }
    let b = accounts.get(account);
    if (!b) {
      b = { hashUnits: 0, taskItems: [] };
      accounts.set(account, b);
    }
    return b;
  }

  /**
   * batchId = keccak(coordinatorId, epoch, seq) per coordinator.md §3.1. In the skeleton we use
   * a dependency-free deterministic 32-byte hex derived from those inputs; the settler swaps in
   * ethers.solidityPackedKeccak256 for the real id (same inputs → same uniqueness contract).
   */
  _batchId(epoch, seq) {
    const s = `${this.coordinatorId}|${epoch}|${seq}`;
    return synthBytes32(s);
  }
}

// ----------------------------- helpers -----------------------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Deterministic 32-byte hex from a string. STUB stand-in for keccak256 (no deps). */
function synthBytes32(s) {
  // 8 independent FNV-1a folds with different seeds → 64 hex chars.
  let out = '0x';
  for (let lane = 0; lane < 8; lane++) {
    let h = (0x811c9dc5 ^ (lane * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export { synthBytes32 };
