const { expect } = require("chai");
const { ethers } = require("hardhat");

// Recreate the OpenZeppelin StandardMerkleTree leaf scheme:
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
// OZ MerkleProof hashes pairs sorted (commutative).
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

describe("MerkleDistributor (airdrop)", function () {
  let token, dist, admin, a, b, other;
  const AMT_A = 100n;
  const AMT_B = 250n;
  let leafA, leafB, root;

  beforeEach(async () => {
    [admin, a, b, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Air", "AIR");

    leafA = leafHash(0, a.address, AMT_A);
    leafB = leafHash(1, b.address, AMT_B);
    root = hashPair(leafA, leafB);

    const MD = await ethers.getContractFactory("MerkleDistributor");
    dist = await MD.deploy(await token.getAddress(), root);
    await token.mint(await dist.getAddress(), 1000n); // fund the distributor
  });

  it("a valid proof claims the allocation and marks it claimed", async () => {
    await expect(dist.claim(0, a.address, AMT_A, [leafB]))
      .to.emit(dist, "Claimed")
      .withArgs(0, a.address, AMT_A);
    expect(await token.balanceOf(a.address)).to.equal(AMT_A);
    expect(await dist.claimed(0)).to.equal(true);

    // the other recipient claims independently
    await dist.claim(1, b.address, AMT_B, [leafA]);
    expect(await token.balanceOf(b.address)).to.equal(AMT_B);
  });

  it("double-claim reverts", async () => {
    await dist.claim(0, a.address, AMT_A, [leafB]);
    await expect(dist.claim(0, a.address, AMT_A, [leafB])).to.be.revertedWith("claimed");
  });

  it("a bad proof reverts", async () => {
    await expect(dist.claim(0, a.address, AMT_A, [leafA])).to.be.revertedWith("bad proof");
  });

  it("a tampered amount reverts", async () => {
    await expect(dist.claim(0, a.address, 999n, [leafB])).to.be.revertedWith("bad proof");
  });

  it("a wrong account reverts", async () => {
    await expect(dist.claim(0, other.address, AMT_A, [leafB])).to.be.revertedWith("bad proof");
  });
});
