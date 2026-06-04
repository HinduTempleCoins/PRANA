// epoch-batcher.test.mjs — node:test units for per-(account,lane) aggregation + batching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EpochBatcher } from '../src/epoch-batcher.mjs';

const A = '0xAAaaAAAaAaAAaAaaAaaaAaAaaAAaAAaAaaaaaAAa';
const B = '0xBBbbBBbBBBbbBBbbBbbBbBbbbBbBbBBbBBbbBBbB';
const CLAIM1 = '0x' + '11'.repeat(32);
const CLAIM2 = '0x' + '22'.repeat(32);
const TASKID = '0x' + '00'.repeat(31) + '01';

const LEN = 100; // epoch length seconds → epoch = floor(ts/100)

function mkValidated(account, normalized) {
  return { account, normalized };
}

test('epochAt + isEpochClosed mirror the on-chain EpochManager math', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  assert.equal(b.epochAt(250), 2); // floor(250/100)
  assert.equal(b.isEpochClosed(2, 299), false); // still inside epoch 2 (200..299)
  assert.equal(b.isEpochClosed(2, 300), true); // now >= (2+1)*100
});

test('HASH shares aggregate per account within an epoch', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  // two shares for A, one for B, all in epoch 1 (ts 100..199)
  b.addHashShare(mkValidated(A, 3), 100);
  b.addHashShare(mkValidated(A, 2), 150);
  b.addHashShare(mkValidated(B, 5), 199);

  const out = b.buildEpochBatch(1);
  assert.equal(out.epoch, 1);
  assert.equal(out.hashBatches.length, 1);
  const hb = out.hashBatches[0];
  // deterministic sort by address; A (0xAA..) < B (0xBB..)
  assert.deepEqual(hb.workers, [A, B]);
  assert.deepEqual(hb.hashShares, [5, 5]); // A: 3+2=5, B: 5
  assert.equal(hb.total, 10);
  assert.match(hb.batchId, /^0x[0-9a-f]{64}$/);
});

test('shares in different epochs do not mix', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  b.addHashShare(mkValidated(A, 4), 120); // epoch 1
  b.addHashShare(mkValidated(A, 7), 230); // epoch 2

  assert.deepEqual(b.pendingEpochs(), [1, 2]);
  assert.equal(b.buildEpochBatch(1).hashBatches[0].hashShares[0], 4);
  assert.equal(b.buildEpochBatch(2).hashBatches[0].hashShares[0], 7);
});

test('large worker sets split into gas-bounded batches with unique batchIds', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  for (let i = 0; i < 5; i++) {
    const addr = '0x' + (i + 1).toString(16).padStart(40, '0');
    b.addHashShare(mkValidated(addr, 1), 100);
  }
  const out = b.buildEpochBatch(1, { maxWorkersPerBatch: 2 });
  assert.equal(out.hashBatches.length, 3); // 2 + 2 + 1
  const ids = out.hashBatches.map((h) => h.batchId);
  assert.equal(new Set(ids).size, 3); // all distinct
  assert.deepEqual(
    out.hashBatches.map((h) => h.workers.length),
    [2, 2, 1],
  );
});

test('TASK completions become per-completion creditVerified entries', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  b.addTaskCompletion({ account: A, claimId: CLAIM1, taskId: TASKID, baseShares: 1 }, 100);
  b.addTaskCompletion({ account: B, claimId: CLAIM2, taskId: TASKID, baseShares: 3 }, 120);

  const out = b.buildEpochBatch(1);
  assert.equal(out.taskCredits.length, 2);
  const byClaim = Object.fromEntries(out.taskCredits.map((t) => [t.claimId, t]));
  assert.equal(byClaim[CLAIM1].account, A);
  assert.equal(byClaim[CLAIM2].baseShares, 3);
  assert.equal(byClaim[CLAIM2].taskId, TASKID);
});

test('buildEpochBatch is non-destructive; drainEpoch clears', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  b.addHashShare(mkValidated(A, 2), 100);
  assert.equal(b.buildEpochBatch(1).hashBatches.length, 1);
  // re-read still returns it (idempotent for settle retries)
  assert.equal(b.buildEpochBatch(1).hashBatches.length, 1);
  b.drainEpoch(1);
  assert.equal(b.buildEpochBatch(1).hashBatches.length, 0);
  assert.deepEqual(b.pendingEpochs(), []);
});

test('closedPendingEpochs returns only epochs whose end has passed', () => {
  const b = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'c' });
  b.addHashShare(mkValidated(A, 1), 100); // epoch 1 (ends at 200)
  b.addHashShare(mkValidated(A, 1), 250); // epoch 2 (ends at 300)
  // at ts 250: epoch 1 closed, epoch 2 still open
  assert.deepEqual(b.closedPendingEpochs(250), [1]);
  // at ts 305: both closed
  assert.deepEqual(b.closedPendingEpochs(305), [1, 2]);
});

test('batchId is deterministic for the same (coordinatorId, epoch, seq)', () => {
  const b1 = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'coordX' });
  const b2 = new EpochBatcher({ epochLengthSeconds: LEN, coordinatorId: 'coordX' });
  b1.addHashShare(mkValidated(A, 1), 100);
  b2.addHashShare(mkValidated(A, 1), 100);
  assert.equal(b1.buildEpochBatch(1).hashBatches[0].batchId, b2.buildEpochBatch(1).hashBatches[0].batchId);
});
