const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// Reproduce the OpenZeppelin StandardMerkleTree leaf + proof scheme used by the
// contract:  leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
// and MerkleProof.verify hashes each pair *sorted* (commutative).
// (Same helper approach as test/MerkleDistributor.test.js, generalized to N leaves.)
// ---------------------------------------------------------------------------
function leafHash(index, account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256"],
      [index, account, amount]
    )
  );
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

// Minimal sorted-pair Merkle tree over an array of leaf hashes.
// Returns { root, proofs: leafHash -> bytes32[] }. Odd nodes are promoted
// (carried up unchanged), matching the common OZ tree shape.
function buildTree(leaves) {
  if (leaves.length === 0) throw new Error("no leaves");
  const proofs = new Map(leaves.map((l) => [l, []]));
  // Track, for each current-layer node, the set of original leaves under it.
  let layer = leaves.map((l) => ({ hash: l, members: [l] }));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const left = layer[i];
        const right = layer[i + 1];
        // every leaf under `left` gets `right.hash` appended, and vice-versa
        for (const m of left.members) proofs.get(m).push(right.hash);
        for (const m of right.members) proofs.get(m).push(left.hash);
        next.push({
          hash: hashPair(left.hash, right.hash),
          members: left.members.concat(right.members),
        });
      } else {
        // promote the odd node unchanged
        next.push(layer[i]);
      }
    }
    layer = next;
  }
  return { root: layer[0].hash, proofs };
}

describe("Adversarial: MerkleDistributor airdrop attacks", function () {
  let token, dist, admin, signers;
  let recipients; // [{ index, account, amount }]
  let leaves, tree;

  const FUND = 100000n;

  beforeEach(async () => {
    signers = await ethers.getSigners();
    admin = signers[0];

    // 5 recipients (odd count → exercises the odd-node promotion path too).
    recipients = [
      { index: 0, account: signers[1].address, amount: 100n },
      { index: 1, account: signers[2].address, amount: 250n },
      { index: 2, account: signers[3].address, amount: 333n },
      { index: 3, account: signers[4].address, amount: 1000n },
      { index: 4, account: signers[5].address, amount: 0n }, // zero-amount leaf
    ];

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Air", "AIR");

    leaves = recipients.map((r) => leafHash(r.index, r.account, r.amount));
    tree = buildTree(leaves);

    const MD = await ethers.getContractFactory("MerkleDistributor");
    dist = await MD.deploy(await token.getAddress(), tree.root);
    await token.mint(await dist.getAddress(), FUND);
  });

  function proofFor(i) {
    return tree.proofs.get(leaves[i]);
  }

  it("sanity: every honest recipient can claim exactly once", async () => {
    for (const r of recipients) {
      await expect(dist.claim(r.index, r.account, r.amount, proofFor(r.index)))
        .to.emit(dist, "Claimed")
        .withArgs(r.index, r.account, r.amount);
      expect(await token.balanceOf(r.account)).to.equal(r.amount);
      expect(await dist.claimed(r.index)).to.equal(true);
    }
  });

  it("double-claim reverts on the second attempt", async () => {
    const r = recipients[0];
    await dist.claim(r.index, r.account, r.amount, proofFor(r.index));
    await expect(
      dist.claim(r.index, r.account, r.amount, proofFor(r.index))
    ).to.be.revertedWith("claimed");
  });

  it("forged proof (valid shape, wrong sibling hashes) reverts", async () => {
    const r = recipients[0];
    const realProof = proofFor(r.index);
    // Same length / shape, but every sibling replaced with a bogus 32-byte value.
    const forged = realProof.map((_, k) =>
      ethers.keccak256(ethers.toUtf8Bytes("forgery-" + k))
    );
    await expect(
      dist.claim(r.index, r.account, r.amount, forged)
    ).to.be.revertedWith("bad proof");
  });

  it("valid proof but wrong index (using another leaf's proof) reverts", async () => {
    const r = recipients[0];
    // Correct account+amount for index 0, but supply index 1's proof.
    await expect(
      dist.claim(r.index, r.account, r.amount, proofFor(1))
    ).to.be.revertedWith("bad proof");

    // And: claim attempting recipient[1]'s index with recipient[0]'s honest leaf
    // data is also rejected (index is part of the leaf preimage).
    await expect(
      dist.claim(recipients[1].index, r.account, r.amount, proofFor(r.index))
    ).to.be.revertedWith("bad proof");
  });

  it("claiming with ANOTHER claimant's proof reverts", async () => {
    const victim = recipients[1];
    const attacker = recipients[3];
    // Attacker tries to redirect victim's allocation to themselves using their own proof.
    await expect(
      dist.claim(victim.index, attacker.account, victim.amount, proofFor(attacker.index))
    ).to.be.revertedWith("bad proof");
    // Attacker tries to claim victim's exact leaf but swapping in their own proof.
    await expect(
      dist.claim(victim.index, victim.account, victim.amount, proofFor(attacker.index))
    ).to.be.revertedWith("bad proof");
  });

  it("tampered amount reverts even with the correct proof", async () => {
    const r = recipients[0];
    await expect(
      dist.claim(r.index, r.account, r.amount + 1n, proofFor(r.index))
    ).to.be.revertedWith("bad proof");
  });

  it("zero-amount leaf: claims successfully, transfers 0, and is single-use", async () => {
    const z = recipients[4]; // amount 0n
    const before = await token.balanceOf(z.account);
    await expect(dist.claim(z.index, z.account, z.amount, proofFor(z.index)))
      .to.emit(dist, "Claimed")
      .withArgs(z.index, z.account, 0n);
    expect((await token.balanceOf(z.account)) - before).to.equal(0n);
    expect(await dist.claimed(z.index)).to.equal(true);
    // still cannot be re-claimed
    await expect(
      dist.claim(z.index, z.account, z.amount, proofFor(z.index))
    ).to.be.revertedWith("claimed");
  });

  // The contract is immutable: it has NO admin sweep and NO expiry/deadline
  // function. The only real "post-funding" failure mode is insolvency — if the
  // contract no longer holds enough tokens, the SafeERC20 transfer reverts.
  // (Documented here so the absence of a sweep/expiry rule is explicit.)
  it("has no admin sweep or expiry hooks (immutable surface)", async () => {
    expect(dist.interface.fragments.some((f) => f.type === "function" && /sweep|withdraw|expire|deadline|recover|owner/i.test(f.name || ""))).to.equal(false);
  });

  it("claim reverts if the distributor is underfunded (insolvency), index stays unclaimed", async () => {
    // Fresh distributor funded with less than the requested allocation.
    const Mock = await ethers.getContractFactory("MockERC20");
    const t2 = await Mock.deploy("Air2", "AIR2");
    const MD = await ethers.getContractFactory("MerkleDistributor");
    const d2 = await MD.deploy(await t2.getAddress(), tree.root);
    await t2.mint(await d2.getAddress(), 10n); // far less than recipient[3].amount (1000n)

    const r = recipients[3];
    await expect(d2.claim(r.index, r.account, r.amount, proofFor(r.index))).to.be.reverted;
    // failed claim did not flip the claimed flag → recipient can still claim once funded
    expect(await d2.claimed(r.index)).to.equal(false);
    await t2.mint(await d2.getAddress(), r.amount);
    await expect(d2.claim(r.index, r.account, r.amount, proofFor(r.index)))
      .to.emit(d2, "Claimed")
      .withArgs(r.index, r.account, r.amount);
  });
});
