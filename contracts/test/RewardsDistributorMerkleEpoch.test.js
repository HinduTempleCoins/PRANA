const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// OZ StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
function leafHash(index, account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256"],
      [index, account, amount]
    )
  );
  return ethers.keccak256(inner);
}
// OZ MerkleProof hashes pairs sorted (commutative).
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

const EPOCH_LEN = 7 * 24 * 60 * 60; // 1 week
const GRACE = 2n;

describe("RewardsDistributorMerkleEpoch", function () {
  async function deployFixture() {
    const [admin, a, b, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Reward", "RWD");

    const Dist = await ethers.getContractFactory("RewardsDistributorMerkleEpoch");
    const dist = await Dist.deploy(await token.getAddress(), EPOCH_LEN, GRACE, admin.address);

    await token.mint(await dist.getAddress(), ethers.parseEther("1000000"));

    // Two-leaf tree for the current epoch.
    const AMT_A = 100n;
    const AMT_B = 250n;
    const leafA = leafHash(0, a.address, AMT_A);
    const leafB = leafHash(1, b.address, AMT_B);
    const root = hashPair(leafA, leafB);
    const funded = AMT_A + AMT_B;

    return { dist, token, admin, a, b, other, AMT_A, AMT_B, leafA, leafB, root, funded };
  }

  it("posts an epoch root + funded amount and a valid proof claims", async () => {
    const { dist, token, a, b, AMT_A, AMT_B, leafA, leafB, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();

    await expect(dist.postEpoch(epoch, root, funded))
      .to.emit(dist, "EpochPosted")
      .withArgs(epoch, root, funded);

    await expect(dist.claim(epoch, 0, a.address, AMT_A, [leafB]))
      .to.emit(dist, "Claimed")
      .withArgs(epoch, 0, a.address, AMT_A);
    expect(await token.balanceOf(a.address)).to.equal(AMT_A);
    expect(await dist.isClaimed(epoch, 0)).to.equal(true);

    await dist.claim(epoch, 1, b.address, AMT_B, [leafA]);
    expect(await token.balanceOf(b.address)).to.equal(AMT_B);

    const e = await dist.epochs(epoch);
    expect(e.claimed).to.equal(funded);
  });

  it("roots are immutable once posted", async () => {
    const { dist, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);
    await expect(dist.postEpoch(epoch, root, funded)).to.be.revertedWithCustomError(dist, "RootExists");
  });

  it("rejects a zero root and non-owner posting", async () => {
    const { dist, a, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await expect(dist.postEpoch(epoch, ethers.ZeroHash, funded)).to.be.revertedWithCustomError(dist, "ZeroRoot");
    await expect(dist.connect(a).postEpoch(epoch, root, funded)).to.be.revertedWithCustomError(
      dist,
      "OwnableUnauthorizedAccount"
    );
  });

  it("double-claim reverts", async () => {
    const { dist, a, AMT_A, leafB, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);
    await dist.claim(epoch, 0, a.address, AMT_A, [leafB]);
    await expect(dist.claim(epoch, 0, a.address, AMT_A, [leafB])).to.be.revertedWithCustomError(
      dist,
      "AlreadyClaimed"
    );
  });

  it("a wrong proof reverts", async () => {
    const { dist, a, AMT_A, leafA, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);
    await expect(dist.claim(epoch, 0, a.address, AMT_A, [leafA])).to.be.revertedWithCustomError(dist, "BadProof");
  });

  it("a tampered amount reverts", async () => {
    const { dist, a, leafB, root, funded } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);
    await expect(dist.claim(epoch, 0, a.address, 999n, [leafB])).to.be.revertedWithCustomError(dist, "BadProof");
  });

  it("claiming an unposted epoch reverts", async () => {
    const { dist, a, AMT_A, leafB } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await expect(dist.claim(epoch, 0, a.address, AMT_A, [leafB])).to.be.revertedWithCustomError(dist, "NoRoot");
  });

  it("sweeps the unclaimed remainder only after the grace period", async () => {
    const { dist, token, admin, a, AMT_A, AMT_B, leafB, root, funded, other } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);

    // a claims, b does not.
    await dist.claim(epoch, 0, a.address, AMT_A, [leafB]);

    // Too early to sweep.
    expect(await dist.isSweepable(epoch)).to.equal(false);
    await expect(dist.sweep(epoch, other.address)).to.be.revertedWithCustomError(dist, "GraceNotElapsed");

    // Advance past grace (grace = 2 whole epochs).
    await time.increase(EPOCH_LEN * 3);
    expect(await dist.isSweepable(epoch)).to.equal(true);

    const before = await token.balanceOf(other.address);
    await expect(dist.sweep(epoch, other.address))
      .to.emit(dist, "Swept")
      .withArgs(epoch, other.address, AMT_B); // only b's unclaimed share
    expect((await token.balanceOf(other.address)) - before).to.equal(AMT_B);

    // Double-sweep reverts.
    await expect(dist.sweep(epoch, other.address)).to.be.revertedWithCustomError(dist, "AlreadySwept");
  });

  it("sweep reverts when nothing remains", async () => {
    const { dist, a, b, AMT_A, AMT_B, leafA, leafB, root, funded, other } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await dist.postEpoch(epoch, root, funded);
    await dist.claim(epoch, 0, a.address, AMT_A, [leafB]);
    await dist.claim(epoch, 1, b.address, AMT_B, [leafA]);
    await time.increase(EPOCH_LEN * 3);
    await expect(dist.sweep(epoch, other.address)).to.be.revertedWithCustomError(dist, "NothingToSweep");
  });

  it("batch-claims across two epochs in one tx", async () => {
    const { dist, token, a, b, AMT_A, AMT_B, leafA, leafB, root, funded } = await loadFixture(deployFixture);
    const epoch0 = await dist.currentEpoch();
    await dist.postEpoch(epoch0, root, funded);

    // Build a second epoch's tree for the SAME two accounts in a later epoch.
    await time.increase(EPOCH_LEN);
    const epoch1 = await dist.currentEpoch();
    expect(epoch1).to.equal(epoch0 + 1n);

    const AMT_A2 = 70n;
    const AMT_B2 = 30n;
    const leafA2 = leafHash(0, a.address, AMT_A2);
    const leafB2 = leafHash(1, b.address, AMT_B2);
    const root2 = hashPair(leafA2, leafB2);
    await dist.postEpoch(epoch1, root2, AMT_A2 + AMT_B2);

    // a claims both epochs in one batch.
    await dist.batchClaim(
      [epoch0, epoch1],
      [0, 0],
      [a.address, a.address],
      [AMT_A, AMT_A2],
      [[leafB], [leafB2]]
    );
    expect(await token.balanceOf(a.address)).to.equal(AMT_A + AMT_A2);
  });

  it("batchClaim reverts on array length mismatch", async () => {
    const { dist, a, AMT_A, leafB } = await loadFixture(deployFixture);
    const epoch = await dist.currentEpoch();
    await expect(
      dist.batchClaim([epoch], [0, 1], [a.address], [AMT_A], [[leafB]])
    ).to.be.revertedWithCustomError(dist, "LengthMismatch");
  });
});
