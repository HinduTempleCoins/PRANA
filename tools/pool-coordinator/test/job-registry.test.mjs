// job-registry.test.mjs — node:test units for the AI-job dedup registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry, JOB_STATUS } from '../src/job-registry.mjs';

const W1 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const W2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const JOB = '0x' + 'ab'.repeat(32);
const JOB2 = '0x' + 'cd'.repeat(32);

test('addJob registers an OPEN job; bad/duplicate ids rejected', () => {
  const r = new JobRegistry();
  assert.equal(r.addJob({ jobId: JOB }).ok, true);
  assert.equal(r.statusOf(JOB), JOB_STATUS.OPEN);
  assert.equal(r.addJob({ jobId: JOB }).reason, 'job-exists');
  assert.equal(r.addJob({ jobId: '0x1234' }).reason, 'bad-jobId');
});

test('first claim wins; double-claim of the same job is rejected (DEDUP)', () => {
  const r = new JobRegistry();
  r.addJob({ jobId: JOB });
  const first = r.claimJob(JOB, W1);
  assert.equal(first.ok, true);
  assert.equal(r.statusOf(JOB), JOB_STATUS.CLAIMED);

  const second = r.claimJob(JOB, W2);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-claimed');
});

test('settle finalizes; settled job can never be re-claimed', () => {
  const r = new JobRegistry();
  r.addJob({ jobId: JOB });
  r.claimJob(JOB, W1);
  assert.equal(r.settleJob(JOB).ok, true);
  assert.equal(r.statusOf(JOB), JOB_STATUS.SETTLED);
  assert.equal(r.claimJob(JOB, W2).reason, 'already-settled');
  assert.equal(r.settleJob(JOB).reason, 'already-settled');
});

test('claimant may release any time; job becomes claimable again', () => {
  const r = new JobRegistry({ claimWindowMs: 10_000 });
  r.addJob({ jobId: JOB });
  r.claimJob(JOB, W1);
  assert.equal(r.releaseJob(JOB, { by: W1 }).ok, true);
  assert.equal(r.statusOf(JOB), JOB_STATUS.OPEN);
  // now W2 can take it.
  assert.equal(r.claimJob(JOB, W2).ok, true);
});

test('non-claimant cannot release before the window; can after', () => {
  let t = 1000;
  const r = new JobRegistry({ claimWindowMs: 5_000, now: () => t });
  r.addJob({ jobId: JOB });
  r.claimJob(JOB, W1);
  // before window
  assert.equal(r.releaseJob(JOB, { by: W2 }).reason, 'claim-window-not-elapsed');
  // after window
  t += 6_000;
  assert.equal(r.releaseJob(JOB, { by: W2 }).ok, true);
  assert.equal(r.statusOf(JOB), JOB_STATUS.OPEN);
});

test('claimed job auto-releases after window on read (nextOpenJob)', () => {
  let t = 0;
  const r = new JobRegistry({ claimWindowMs: 1_000, now: () => t });
  r.addJob({ jobId: JOB });
  r.claimJob(JOB, W1);
  assert.equal(r.nextOpenJob(), null); // claimed → not open
  t += 2_000;
  const next = r.nextOpenJob();
  assert.ok(next && next.jobId === JOB); // window elapsed → handed out again
});

test('nextOpenJob returns an open job; counts reflect lifecycle', () => {
  const r = new JobRegistry();
  r.addJob({ jobId: JOB });
  r.addJob({ jobId: JOB2 });
  assert.deepEqual(r.counts(), { open: 2, claimed: 0, settled: 0, total: 2 });
  r.claimJob(JOB, W1);
  r.settleJob(JOB);
  assert.deepEqual(r.counts(), { open: 1, claimed: 0, settled: 1, total: 2 });
});

test('isClaimed true once claimed or settled, false when open/released', () => {
  const r = new JobRegistry();
  r.addJob({ jobId: JOB });
  assert.equal(r.isClaimed(JOB), false);
  r.claimJob(JOB, W1);
  assert.equal(r.isClaimed(JOB), true);
  r.releaseJob(JOB, { by: W1 });
  assert.equal(r.isClaimed(JOB), false);
});
