const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FeeCollectorBurner", function () {
  let token, burner, admin;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Fee", "FEE");
    const B = await ethers.getContractFactory("FeeCollectorBurner");
    burner = await B.deploy(await token.getAddress());
  });

  it("burns the accumulated balance on sweep", async () => {
    await token.mint(await burner.getAddress(), 500n);
    expect(await burner.pending()).to.equal(500n);
    await burner.sweep();
    expect(await token.totalSupply()).to.equal(0n);
    expect(await burner.totalBurned()).to.equal(500n);
    expect(await burner.pending()).to.equal(0n);
  });

  it("reverts sweeping nothing", async () => {
    await expect(burner.sweep()).to.be.revertedWith("nothing");
  });
});
