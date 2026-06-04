// Tests for lib/airdrop-builder.mjs — Merkle airdrop builder.
// Verifies the leaf format matches the on-chain MerkleDistributor EXACTLY:
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
// and that proofs verify the way OZ MerkleProof.verify (commutative pair hash) does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, getAddress } from 'ethers';
import {
  buildAirdrop,
  leafHash,
  verifyProof,
  normalizeHolders,
  claimArgs,
} from '../lib/airdrop-builder.mjs';

const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const D = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const E = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';

const abi = AbiCoder.defaultAbiCoder();

// Re-implement the contract's leaf scheme independently to cross-check.
function contractLeaf(index, account, amount) {
  const inner = keccak256(abi.encode(['uint256', 'address', 'uint256'], [BigInt(index), getAddress(account), BigInt(amount)]));
  return keccak256(inner);
}

// Commutative pair hash exactly as OZ MerkleProof._hashPair (sorted asc).
function hashPair(a, b) {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256('0x' + lo.slice(2) + hi.slice(2));
}

test('leafHash matches the contract double-hash scheme exactly', () => {
  assert.equal(leafHash(0, A, 1000n), contractLeaf(0, A, 1000n));
  assert.equal(leafHash(7, B, 12345678901234567890n), contractLeaf(7, B, 12345678901234567890n));
});

test('single-recipient tree: root == the only leaf, empty proof verifies', () => {
  const { root, claims, count, total } = buildAirdrop([{ address: A, amount: 500n }]);
  assert.equal(count, 1);
  assert.equal(total, 500n);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].proof.length, 0);
  assert.equal(root, leafHash(0, A, 500n));
  assert.ok(verifyProof(claims[0].proof, root, claims[0].leaf));
});

test('two-recipient tree: root == hashPair of the two leaves; proofs verify', () => {
  const { root, claims } = buildAirdrop([
    { address: A, amount: 1n },
    { address: B, amount: 2n },
  ]);
  const lA = leafHash(0, A, 1n);
  const lB = leafHash(1, B, 2n);
  assert.equal(root, hashPair(lA, lB));
  for (const c of claims) {
    assert.ok(verifyProof(c.proof, root, c.leaf), `proof for ${c.account} verifies`);
  }
});

test('odd (5) recipients: every proof verifies against the root', () => {
  const holders = [
    { address: A, amount: 100n },
    { address: B, amount: 200n },
    { address: C, amount: 300n },
    { address: D, amount: 400n },
    { address: E, amount: 500n },
  ];
  const { root, claims, total, count } = buildAirdrop(holders);
  assert.equal(count, 5);
  assert.equal(total, 1500n);
  for (const c of claims) {
    assert.equal(c.leaf, leafHash(c.index, c.account, c.amount));
    assert.ok(verifyProof(c.proof, root, c.leaf), `proof for index ${c.index} verifies`);
  }
});

test('a tampered amount fails verification against the root', () => {
  const { root, claims } = buildAirdrop([
    { address: A, amount: 100n },
    { address: B, amount: 200n },
    { address: C, amount: 300n },
  ]);
  const c = claims[0];
  const badLeaf = leafHash(c.index, c.account, c.amount + 1n);
  assert.ok(!verifyProof(c.proof, root, badLeaf));
});

test('claimArgs produces MerkleDistributor and epoch-distributor arg shapes', () => {
  const { claims } = buildAirdrop([{ address: A, amount: 9n }]);
  const c = claims[0];
  // MerkleDistributor.claim(index, account, amount, proof)
  assert.deepEqual(claimArgs(c), [c.index, c.account, c.amount, c.proof]);
  // RewardsDistributorMerkleEpoch.claim(epoch, index, account, amount, proof)
  assert.deepEqual(claimArgs(c, 42n), [42n, c.index, c.account, c.amount, c.proof]);
});

test('byAddress lookup is keyed by lower-cased address', () => {
  const { byAddress } = buildAirdrop([
    { address: A, amount: 1n },
    { address: B, amount: 2n },
  ]);
  assert.ok(byAddress[A.toLowerCase()]);
  assert.equal(byAddress[B.toLowerCase()].amount, 2n);
});

test('amounts accept decimal/hex strings and numbers', () => {
  const { claims } = buildAirdrop([
    { address: A, amount: '1000000000000000000' },
    { address: B, amount: '0x10' },
    { address: C, amount: 5 },
  ]);
  assert.equal(claims[0].amount, 1000000000000000000n);
  assert.equal(claims[1].amount, 16n);
  assert.equal(claims[2].amount, 5n);
});

test('normalizeHolders assigns 0-based indexes in order and checksums', () => {
  const e = normalizeHolders([
    { address: A.toLowerCase(), amount: 1n },
    { address: B.toLowerCase(), amount: 2n },
  ]);
  assert.equal(e[0].index, 0);
  assert.equal(e[1].index, 1);
  assert.equal(e[0].account, getAddress(A));
});

test('rejects empty list, bad address, zero amount, and duplicates', () => {
  assert.throws(() => buildAirdrop([]), /non-empty/);
  assert.throws(() => buildAirdrop([{ address: '0xnope', amount: 1n }]), /invalid address/);
  assert.throws(() => buildAirdrop([{ address: A, amount: 0n }]), /must be > 0/);
  assert.throws(
    () => buildAirdrop([{ address: A, amount: 1n }, { address: A.toLowerCase(), amount: 2n }]),
    /duplicate/,
  );
});
