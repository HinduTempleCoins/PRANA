const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenVesting", function () {
  let token, vest, admin, ben;
  const TOTAL = 1000n;
  const DURATION = 1000; // seconds
  const CLIFF = 200;     // seconds

  beforeEach(async () => {
    [admin, ben] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Vest", "VST");

    const start = (await time.latest()) + 10;
    const V = await ethers.getContractFactory("TokenVesting");
    vest = await V.deploy(await token.getAddress(), ben.address, start, CLIFF, DURATION, TOTAL);
    await token.mint(await vest.getAddress(), TOTAL); // fund the vesting contract
  });

  it("releases nothing before the cliff", async () => {
    expect(await vest.releasable()).to.equal(0n);
    await expect(vest.release()).to.be.revertedWith("nothing to release");
  });

  it("vests linearly after the cliff and fully after duration", async () => {
    const start = Number(await vest.start());
    // vestedAmount is a pure function of the timestamp: exactly 50% at start+500
    expect(await vest.vestedAmount(start + 500)).to.equal(500n);

    // release() mines at ~start+500 (the tx may land a second later), so allow a small band
    await time.increaseTo(start + 500);
    await vest.release();
    const bal = await token.balanceOf(ben.address);
    expect(bal >= 500n && bal <= 505n).to.equal(true);

    // jump past the end -> fully vested
    await time.increaseTo(start + DURATION + 1);
    await vest.release();
    expect(await token.balanceOf(ben.address)).to.equal(TOTAL);
    expect(await vest.releasable()).to.equal(0n);
  });

  it("rejects a cliff longer than the duration at construction", async () => {
    const V = await ethers.getContractFactory("TokenVesting");
    const start = await time.latest();
    await expect(
      V.deploy(await token.getAddress(), ben.address, start, DURATION + 1, DURATION, TOTAL)
    ).to.be.revertedWith("cliff>duration");
  });
});
