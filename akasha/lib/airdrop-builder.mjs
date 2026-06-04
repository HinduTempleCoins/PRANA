/**
 * airdrop-builder.mjs — AK15 (creator systems: Merkle airdrop builder)
 *
 * Headless builder for an ERC-20 Merkle airdrop. Given a holder list
 * `[{ address, amount }]` it builds the Merkle tree, returns the root, and emits
 * a per-recipient claim payload (index, account, amount, proof) that the on-chain
 * {MerkleDistributor} / {RewardsDistributorMerkleEpoch} `claim(...)` accepts
 * verbatim.
 *
 * LEAF FORMAT (matched EXACTLY to the contracts — do NOT change without changing
 * the Solidity too). Both contracts compute:
 *
 *     leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
 *
 * i.e. the OpenZeppelin StandardMerkleTree "double-hash" leaf scheme over the
 * tuple (uint256 index, address account, uint256 amount). Verification uses
 * OpenZeppelin `MerkleProof.verify`, whose `_hashPair` is COMMUTATIVE: it hashes
 * the two children in ascending byte order (`a < b ? keccak(a,b) : keccak(b,a)`).
 * Our tree-builder therefore sorts each pair the same way, so the proofs verify
 * against the on-chain root with no extra sort flags.
 *
 *   - index   : assigned here, 0-based, in input order (stable). This is the
 *               per-claim single-use slot the contract tracks via `claimed[index]`
 *               / `isClaimed[epoch][index]`.
 *   - account : EIP-55 address.
 *   - amount  : token base units (wei), as a BigInt / decimal-or-hex string.
 *
 * NOTE (UD/AK18 — gated user decision): mass token distributions / airdrops may
 * carry securities-law implications depending on jurisdiction and how the offering
 * is framed. The securities-framing layer (AK18) is a USER decision and is NOT
 * built here — surface it before any real distribution.
 *
 * Pure: touches no key and no network. Uses ethers v6 primitives only
 * (AbiCoder + keccak256), so it needs no extra merkle dependency.
 */

import { AbiCoder, keccak256, getAddress, isAddress, getBigInt } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();

// ---- leaf + pair hashing (must mirror the Solidity exactly) -----------------

/**
 * Compute the double-hashed leaf for one allocation.
 *   keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
 * @param {bigint|number|string} index
 * @param {string} account  20-byte address
 * @param {bigint|number|string} amount  base units (wei)
 * @returns {string} 0x… 32-byte leaf
 */
export function leafHash(index, account, amount) {
  const inner = keccak256(
    abi.encode(['uint256', 'address', 'uint256'], [getBigInt(index), getAddress(account), getBigInt(amount)]),
  );
  // double hash (OZ StandardMerkleTree scheme)
  return keccak256(inner);
}

/** Commutative pair hash, matching OZ MerkleProof `_hashPair` (sorted ascending). */
function hashPair(a, b) {
  // a, b are 0x-prefixed 32-byte hex; compare as unsigned big-endian.
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256('0x' + lo.slice(2) + hi.slice(2));
}

// ---- input normalization ----------------------------------------------------

/**
 * Validate + normalize a holder list into canonical entries with assigned index.
 * Dedupes by address (case-insensitive); rejects bad addresses and non-positive
 * amounts. Indexes are assigned in (post-dedupe) input order, 0-based.
 * @param {{address:string, amount:(bigint|number|string)}[]} holders
 * @returns {{index:number, account:string, amount:bigint}[]}
 */
export function normalizeHolders(holders) {
  if (!Array.isArray(holders) || holders.length === 0) {
    throw new Error('airdrop: holders must be a non-empty array');
  }
  const seen = new Set();
  const out = [];
  holders.forEach((h, i) => {
    if (!h || !isAddress(h.address)) {
      throw new Error(`airdrop: holder #${i} has an invalid address: ${JSON.stringify(h?.address)}`);
    }
    const account = getAddress(h.address);
    const key = account.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`airdrop: duplicate address ${account} (holder #${i})`);
    }
    let amount;
    try {
      amount = getBigInt(h.amount);
    } catch {
      throw new Error(`airdrop: holder #${i} (${account}) has an invalid amount: ${JSON.stringify(h.amount)}`);
    }
    if (amount <= 0n) {
      throw new Error(`airdrop: holder #${i} (${account}) amount must be > 0`);
    }
    seen.add(key);
    out.push({ index: out.length, account, amount });
  });
  return out;
}

// ---- tree construction ------------------------------------------------------

/**
 * Build the full Merkle tree (array of levels of node hashes). Level 0 = sorted
 * leaves; the top level is a single root. Odd nodes are promoted (carried up)
 * unchanged — the OZ-compatible convention used here.
 * @param {string[]} leaves  0x 32-byte hashes
 * @returns {string[][]} levels, levels[0] = leaves (sorted), last = [root]
 */
function buildLevels(leaves) {
  if (leaves.length === 0) throw new Error('airdrop: cannot build a tree with no leaves');
  // Sort leaves ascending so the layout is deterministic and proofs are minimal.
  const sorted = [...leaves].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a === b ? 0 : 1));
  const levels = [sorted];
  let cur = sorted;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) {
        next.push(cur[i]); // promote a lone node
      } else {
        next.push(hashPair(cur[i], cur[i + 1]));
      }
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** Build the proof (sibling path) for the leaf at `leafIndexInSorted`. */
function proofFor(levels, leafIndexInSorted) {
  const proof = [];
  let idx = leafIndexInSorted;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const pairIdx = idx ^ 1; // sibling
    if (pairIdx < nodes.length) {
      proof.push(nodes[pairIdx]);
    }
    // if there was no sibling (lone promoted node), nothing is added.
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ---- public builder ---------------------------------------------------------

/**
 * Build a complete Merkle airdrop: root + per-recipient claim payloads.
 *
 * @param {{address:string, amount:(bigint|number|string)}[]} holders
 * @returns {{
 *   root: string,
 *   total: bigint,
 *   count: number,
 *   claims: {
 *     index: number, account: string, amount: bigint,
 *     leaf: string, proof: string[],
 *   }[],
 *   byAddress: Record<string, object>,  // lower-cased address -> claim
 * }}
 */
export function buildAirdrop(holders) {
  const entries = normalizeHolders(holders);

  // leaf per entry (in input/index order)
  const leafByIndex = entries.map((e) => leafHash(e.index, e.account, e.amount));

  const levels = buildLevels(leafByIndex);
  const root = levels[levels.length - 1][0];
  const sortedLeaves = levels[0];

  // map each leaf hash to its position in the sorted leaf layer
  const posOf = new Map();
  sortedLeaves.forEach((h, i) => posOf.set(h, i));

  const claims = entries.map((e) => {
    const leaf = leafByIndex[e.index];
    const pos = posOf.get(leaf);
    const proof = proofFor(levels, pos);
    return { index: e.index, account: e.account, amount: e.amount, leaf, proof };
  });

  const byAddress = {};
  for (const c of claims) byAddress[c.account.toLowerCase()] = c;

  const total = entries.reduce((acc, e) => acc + e.amount, 0n);

  return { root, total, count: entries.length, claims, byAddress };
}

/**
 * Verify a single proof against a root locally (mirrors OZ MerkleProof.verify).
 * Useful for tests and pre-submit sanity checks.
 * @returns {boolean}
 */
export function verifyProof(proof, root, leaf) {
  let computed = leaf;
  for (const sib of proof) {
    computed = hashPair(computed, sib);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

/**
 * Build the exact args for an on-chain `claim(...)` call.
 *   - MerkleDistributor.claim(index, account, amount, proof)
 *   - RewardsDistributorMerkleEpoch.claim(epoch, index, account, amount, proof)
 *     (pass `epoch` to prepend it).
 * @param {object} claim  a claim object from buildAirdrop().claims
 * @param {bigint|number} [epoch]  if given, prepended for the epoch distributor
 * @returns {any[]} positional args ready to spread into the contract call
 */
export function claimArgs(claim, epoch) {
  const base = [claim.index, claim.account, claim.amount, claim.proof];
  return epoch === undefined || epoch === null ? base : [epoch, ...base];
}

export default {
  leafHash,
  normalizeHolders,
  buildAirdrop,
  verifyProof,
  claimArgs,
};
