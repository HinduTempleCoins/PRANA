const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Recreate the OpenZeppelin StandardMerkleTree leaf scheme (double keccak256):
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
function leafHash(index, account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256"],
      [index, account, amount]
    )
  );
  return ethers.keccak256(inner);
}
// OZ MerkleProof hashes pairs sorted (commutative, lexicographic on the 0x-hex).
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

describe("MerkleClaimDeadline", function () {
  let token, drop, owner, a, b, other;
  const AMT_A = 100n;
  const AMT_B = 250n;
  const FUND = 1000n;
  let leafA, leafB, root, deadline;

  beforeEach(async () => {
    [owner, a, b, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Air", "AIR");

    // Two-leaf Merkle tree built manually.
    leafA = leafHash(0, a.address, AMT_A);
    leafB = leafHash(1, b.address, AMT_B);
    root = hashPair(leafA, leafB);

    deadline = BigInt(await time.latest()) + 3600n; // 1 hour out

    const Drop = await ethers.getContractFactory("MerkleClaimDeadline");
    drop = await Drop.deploy(await token.getAddress(), root, deadline, owner.address);
    await token.mint(await drop.getAddress(), FUND);
  });

  it("claims a valid allocation before the deadline", async () => {
    await expect(drop.claim(0, a.address, AMT_A, [leafB]))
      .to.emit(drop, "Claimed")
      .withArgs(0, a.address, AMT_A);
    expect(await token.balanceOf(a.address)).to.equal(AMT_A);
    expect(await drop.claimed(0)).to.equal(true);

    await drop.claim(1, b.address, AMT_B, [leafA]);
    expect(await token.balanceOf(b.address)).to.equal(AMT_B);
  });

  it("reverts a claim after the deadline", async () => {
    await time.increaseTo(deadline + 1n);
    await expect(drop.claim(0, a.address, AMT_A, [leafB])).to.be.revertedWith("deadline passed");
  });

  it("reverts a double-claim", async () => {
    await drop.claim(0, a.address, AMT_A, [leafB]);
    await expect(drop.claim(0, a.address, AMT_A, [leafB])).to.be.revertedWith("claimed");
  });

  it("reverts a bad proof", async () => {
    await expect(drop.claim(0, a.address, AMT_A, [leafA])).to.be.revertedWith("bad proof");
  });

  it("lets the owner sweep the remainder after the deadline", async () => {
    await drop.claim(0, a.address, AMT_A, [leafB]); // leaves FUND - AMT_A
    const remaining = FUND - AMT_A;

    await time.increaseTo(deadline + 1n);
    await expect(drop.connect(owner).sweep(other.address))
      .to.emit(drop, "Swept")
      .withArgs(other.address, remaining);
    expect(await token.balanceOf(other.address)).to.equal(remaining);
    expect(await token.balanceOf(await drop.getAddress())).to.equal(0n);
  });

  it("reverts a sweep before the deadline", async () => {
    await expect(drop.connect(owner).sweep(other.address)).to.be.revertedWith("not ended");
  });
});
