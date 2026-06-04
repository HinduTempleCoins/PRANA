// task-lane.mjs — STUB AI-job runner (the TASK lane).
//
// Spec: design/compute/switching-worker.md §1 (`tasker`) + §5.2. The REAL daemon claims a
// redundant task copy from the coordinator (tryClaimTask), runs the AI/compute job, and
// returns a result PLUS attestation material. It does NOT self-certify: the result is gated
// K-of-N by TaskVerificationGate before any TASK credit is minted (a forged TASK share is
// worth a real HASH share — switching-worker.md §0). The daemon never sets its own weight or
// recipient; both come from on-chain governed state (ITaskRegistry) and the gate-bound worker.
//
// WHAT IS STUBBED: there is NO real model/inference/CUDA here. runTask() is a deterministic
// pure function of the job input (so the "result" is reproducible and tests are stable).
//
// REAL: the claim/result/attestation SHAPES that map onto
//   TaskLaneCreditor.creditVerified(claimId, taskId, baseShares).
// STUB: the actual computation.

import { createHash } from 'node:crypto';

/**
 * "Run" a task deterministically. A real runner would do inference/training-shard work; we
 * hash the job spec + input to a reproducible output digest so redundant copies (run by
 * different workers) agree, which is exactly what K-of-N attestation checks.
 *
 * @param {object} job  as handed back by coordinator.tryClaimTask
 * @param {string} job.claimId  coordinator-opened verification claim id
 * @param {string} job.taskId   task-type whose governed shareWeight applies
 * @param {string} job.specHash ITaskRegistry specHash (which runner/model)
 * @param {string} job.input    job input payload (deterministic stub hashes this)
 * @param {number} [job.baseShares] equal-weight unit count for this completion (default 1)
 * @param {string} workerAddr   beacon-bound payout address
 * @returns {{worker:string, lane:'TASK', claimId:string, taskId:string, baseShares:number, resultDigest:string, attestation:object}}
 */
export function runTask(job, workerAddr) {
  if (!job || !job.claimId || !job.taskId) {
    throw new Error('task-lane: job must have claimId + taskId');
  }
  const input = job.input ?? '';
  const specHash = job.specHash ?? '0x0';

  // deterministic "compute" — the stubbed work product.
  const resultDigest =
    '0x' + createHash('sha256').update(`${specHash}|${input}`).digest('hex');

  const baseShares = Number.isFinite(job.baseShares) ? job.baseShares : 1;

  return {
    worker: workerAddr, // the gate binds credit to THIS worker; cannot be redirected on-chain
    lane: 'TASK', // mirrors IUnifiedSharesLedger.Lane.TASK
    claimId: job.claimId,
    taskId: job.taskId,
    baseShares, // -> TaskLaneCreditor.creditVerified(..., baseShares); weight read on-chain
    resultDigest,
    // attestation material: what the K-of-N attestors re-derive to agree on the result.
    // The daemon does NOT certify itself — this is just the evidence package (SS4).
    attestation: {
      specHash,
      resultDigest,
      inputHash: '0x' + createHash('sha256').update(String(input)).digest('hex'),
    },
  };
}

/**
 * Build the submission the daemon sends to the coordinator (submitTaskResult). The
 * coordinator opens/derives the claim, dispatches attestation, and (after K-of-N Verified)
 * settles via TaskLaneCreditor.creditVerified(claimId, taskId, baseShares). NOTE: no share
 * is "earned" until attestation passes — payout is async via UnifiedSharesLedger.claim(epoch).
 *
 * @param {ReturnType<typeof runTask>} result
 * @returns {{type:'taskResult', worker:string, lane:'TASK', claimId:string, taskId:string, baseShares:number, resultDigest:string, attestation:object}}
 */
export function toSubmission(result) {
  return {
    type: 'taskResult',
    worker: result.worker,
    lane: 'TASK',
    claimId: result.claimId,
    taskId: result.taskId,
    baseShares: result.baseShares,
    resultDigest: result.resultDigest,
    attestation: result.attestation,
  };
}
