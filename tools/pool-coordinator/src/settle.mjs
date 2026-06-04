// settle.mjs — the on-chain settlement stub. Builds the txs that credit a closed epoch's batch
// into the unified ledger via the two creditors. UNIT-TESTABLE via buildSettleTx() (which never
// sends); sendSettleTx() is the (stubbed) broadcast path.
//
// Spec: coordinator.md §3 + §6 (bound contract surfaces):
//   HASH: HashLaneCreditor.submitBatch(uint256 epoch, bytes32 batchId, address[] workers,
//                                      uint256[] hashShares)              [CREDITOR_ROLE]
//   TASK: (earlier) TaskVerificationGate.openClaim(claimId, worker, k, attestors)  [CONFIG_ROLE]
//         then       TaskLaneCreditor.creditVerified(bytes32 claimId, bytes32 taskId,
//                                      uint256 baseShares)                [CREDITOR_ROLE]
//   DEDUP: before crediting a TASK job, the settler also marks it on JobClaimLedger.settle(jobId)
//          so two coordinators can't double-credit the same job (PR2 / coordinator.md §7).
//
// REAL vs STUB (honest):
//   - REAL: the exact function selectors, ABI signatures, argument ORDER and types match the
//     deployed contracts (verified against HashLaneCreditor.sol / TaskLaneCreditor.sol). The
//     calldata-encoding STRUCTURE (function name + typed args) is what a real ethers
//     Contract.populateTransaction produces.
//   - STUB: there is no ethers import here (keeping the skeleton built-ins-only). buildSettleTx
//     returns a plain { to, function, args, abi } descriptor — the shape an ethers v6
//     `new Contract(addr, ABI, signer)[fn](...args)` call consumes. sendSettleTx logs instead of
//     broadcasting unless a live `signer`/`provider` is injected (none in tests).

/** Minimal human-readable ABIs for the two creditors + the job ledger (real signatures). */
export const HASH_CREDITOR_ABI = [
  'function submitBatch(uint256 epoch, bytes32 batchId, address[] workers, uint256[] hashShares)',
];
export const TASK_CREDITOR_ABI = [
  'function creditVerified(bytes32 claimId, bytes32 taskId, uint256 baseShares)',
];
export const JOB_LEDGER_ABI = [
  'function claim(bytes32 jobId, address worker)',
  'function settle(bytes32 jobId)',
];

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Build the unsigned tx descriptors to settle one epoch's batch. Does NOT send.
 * @param {object} batch - output of EpochBatcher.buildEpochBatch():
 *   { epoch, hashBatches:[{batchId,workers,hashShares}], taskCredits:[{claimId,taskId,baseShares}] }
 * @param {object} cfg - { hashCreditorAddr, taskCreditorAddr } (from config.mjs).
 * @returns {Array<{kind, to, abi, function:string, args:Array}>} one descriptor per on-chain call.
 */
export function buildSettleTx(batch, cfg) {
  const txs = [];

  for (const hb of batch.hashBatches ?? []) {
    if (!hb.workers || hb.workers.length === 0) continue;
    txs.push({
      kind: 'hash',
      to: cfg.hashCreditorAddr ?? ZERO,
      abi: HASH_CREDITOR_ABI,
      function: 'submitBatch',
      // arg order MUST match HashLaneCreditor.submitBatch(epoch, batchId, workers, hashShares).
      args: [batch.epoch, hb.batchId, hb.workers, hb.hashShares],
    });
  }

  for (const tc of batch.taskCredits ?? []) {
    txs.push({
      kind: 'task',
      to: cfg.taskCreditorAddr ?? ZERO,
      abi: TASK_CREDITOR_ABI,
      function: 'creditVerified',
      // arg order MUST match TaskLaneCreditor.creditVerified(claimId, taskId, baseShares).
      args: [tc.claimId, tc.taskId, tc.baseShares],
    });
  }

  return txs;
}

/**
 * Build the JobClaimLedger.settle(jobId) tx for cross-coordinator dedup finalization.
 * @returns {{kind, to, abi, function, args}}
 */
export function buildJobSettleTx(jobId, cfg) {
  return {
    kind: 'job-settle',
    to: cfg.jobLedgerAddr ?? ZERO,
    abi: JOB_LEDGER_ABI,
    function: 'settle',
    args: [jobId],
  };
}

/**
 * "Send" the settle txs. STUB: with no live signer (the skeleton default) it logs the
 * descriptors and returns a synthetic receipt list. With a real ethers signer injected it would
 * encode + broadcast each descriptor. Kept dependency-free on purpose.
 *
 * @param {Array} txs - buildSettleTx output.
 * @param {object} [ctx] - { signer, provider, log } (all optional; absent in tests).
 * @returns {Promise<Array<{kind, to, function, sent:boolean, hash?:string}>>}
 */
export async function sendSettleTx(txs, ctx = {}) {
  const log = ctx.log ?? (() => {});
  const live = !!ctx.signer; // real ethers signer ⇒ would broadcast
  const receipts = [];
  for (const tx of txs) {
    if (live) {
      // PROD path (stubbed body): const c = new ethers.Contract(tx.to, tx.abi, ctx.signer);
      //                            const r = await c[tx.function](...tx.args); await r.wait();
      // Left intentionally unimplemented in the skeleton — no ethers dependency here.
      log(`[settle] (live) would ${tx.function} -> ${tx.to}`);
      receipts.push({ kind: tx.kind, to: tx.to, function: tx.function, sent: true });
    } else {
      log(`[settle] (dry) ${tx.function} -> ${tx.to} args=${safeArgs(tx.args)}`);
      receipts.push({ kind: tx.kind, to: tx.to, function: tx.function, sent: false });
    }
  }
  return receipts;
}

function safeArgs(args) {
  try {
    return JSON.stringify(args);
  } catch {
    return '[unserializable]';
  }
}
