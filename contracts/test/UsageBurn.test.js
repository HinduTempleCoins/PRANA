const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UsageBurn (burn-to-use)", function () {
  let token, gate, admin, user;

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Usage", "USE");
    const UB = await ethers.getContractFactory("UsageBurn");
    gate = await UB.deploy(await token.getAddress());
    await token.mint(user.address, 1000n);
  });

  it("burns on use and tallies per-user + total", async () => {
    await token.connect(user).approve(await gate.getAddress(), 1000n);
    const ref = ethers.encodeBytes32String("content-1");
    await expect(gate.connect(user).use(300n, ref))
      .to.emit(gate, "Used")
      .withArgs(user.address, 300n, ref);

    expect(await token.balanceOf(user.address)).to.equal(700n);
    expect(await token.totalSupply()).to.equal(700n);   // burned
    expect(await gate.burnedBy(user.address)).to.equal(300n);
    expect(await gate.totalBurned()).to.equal(300n);
  });

  it("reverts on zero amount", async () => {
    await expect(
      gate.connect(user).use(0n, ethers.ZeroHash)
    ).to.be.revertedWith("amount=0");
  });

  it("requires approval (burnFrom)", async () => {
    await expect(
      gate.connect(user).use(100n, ethers.ZeroHash)
    ).to.be.reverted;
  });
});
