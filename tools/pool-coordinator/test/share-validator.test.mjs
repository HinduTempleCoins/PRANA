// share-validator.test.mjs — node:test units for the share validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateShare,
  checkAttestationShape,
  expectedSyntheticProof,
} from '../src/share-validator.mjs';

const ACC = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ATT1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ATT2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ATT3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const CLAIM = '0x' + 'ab'.repeat(32);

function validHashShare(overrides = {}) {
  const base = { workerId: 'w1', account: ACC, lane: 'hash', difficulty: 1000, nonce: 42 };
  const s = { ...base, ...overrides };
  s.proof = overrides.proof ?? expectedSyntheticProof(s.workerId, s.nonce, s.difficulty);
  return s;
}

function attestation({ k = 2, n = 3, verified = 3 } = {}) {
  const addrs = [ATT1, ATT2, ATT3].slice(0, n);
  return {
    claimId: CLAIM,
    k,
    n,
    attestors: addrs.map((addr, i) => ({ addr, verified: i < verified })),
  };
}

test('HASH share with correct synthetic proof is accepted + vardiff-normalized', () => {
  const r = validateShare(validHashShare({ difficulty: 2000 }), { minDifficulty: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.lane, 'hash');
  assert.equal(r.account, ACC);
  assert.equal(r.normalized, 2); // 2000 / 1000
});

test('HASH share with wrong proof is rejected', () => {
  const r = validateShare(validHashShare({ proof: '0xdeadbeef' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-pow-proof');
});

test('share below the vardiff floor is rejected', () => {
  const r = validateShare(validHashShare({ difficulty: 500 }), { minDifficulty: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'below-min-difficulty');
});

test('bad lane / account / workerId / difficulty are each rejected', () => {
  assert.equal(validateShare({ ...validHashShare(), lane: 'xyz' }).reason, 'bad-lane:xyz');
  assert.equal(validateShare({ ...validHashShare(), account: '0x1234' }).reason, 'bad-account');
  assert.equal(validateShare({ ...validHashShare(), workerId: '' }).reason, 'bad-workerId');
  assert.equal(validateShare({ ...validHashShare(), difficulty: 0 }).reason, 'bad-difficulty');
});

test('TASK share with K-of-N quorum met is accepted', () => {
  const r = validateShare(
    { workerId: 'w1', account: ACC, lane: 'task', difficulty: 1000, result: 'inference-out', attestation: attestation({ k: 2, n: 3, verified: 2 }) },
    { attestK: 2, attestN: 3 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.lane, 'task');
  assert.equal(r.claimId, CLAIM);
});

test('TASK share missing result is rejected', () => {
  const r = validateShare({ workerId: 'w1', account: ACC, lane: 'task', difficulty: 1000, attestation: attestation() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-task-result');
});

test('TASK share without quorum (verified < k) is rejected', () => {
  const att = attestation({ k: 3, n: 3, verified: 2 });
  const r = checkAttestationShape(att);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^quorum-not-met:2\/3$/);
});

test('attestation shape: bad k/n range and count mismatch rejected', () => {
  assert.equal(checkAttestationShape({ claimId: CLAIM, k: 4, n: 3, attestors: [] }).reason, 'bad-kn-range');
  assert.equal(
    checkAttestationShape({ claimId: CLAIM, k: 2, n: 3, attestors: [{ addr: ATT1, verified: true }] }).reason,
    'attestor-count-mismatch',
  );
});

test('attestation shape: duplicate attestor rejected', () => {
  const att = { claimId: CLAIM, k: 1, n: 2, attestors: [{ addr: ATT1, verified: true }, { addr: ATT1, verified: true }] };
  assert.equal(checkAttestationShape(att).reason, 'duplicate-attestor');
});

test('coordinator K-of-N bounds enforced (k below min)', () => {
  const att = attestation({ k: 1, n: 3, verified: 3 });
  const r = checkAttestationShape(att, { attestK: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'k-below-coordinator-min');
});
