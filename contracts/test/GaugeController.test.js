const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GaugeController", function () {
  let token, ve, gc, admin, u1, u2, g1, g2;
  const MAX = 1000;

  beforeEach(async () => {
    [admin, u1, u2, g1, g2] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Gov", "GOV");
    const VE = await ethers.getContractFactory("VoteEscrow");
    ve = await VE.deploy(await token.getAddress(), MAX);
    const GC = await ethers.getContractFactory("GaugeController");
    gc = await GC.deploy(await ve.getAddress());

    await token.mint(u1.address, 1000n);
    await token.mint(u2.address, 1000n);
    await token.connect(u1).approve(await ve.getAddress(), 1000n);
    await token.connect(u2).approve(await ve.getAddress(), 1000n);
    await ve.connect(u1).lock(1000n, MAX);
    await ve.connect(u2).lock(500n, MAX);

    await gc.addGauge(g1.address);
    await gc.addGauge(g2.address);
  });

  it("splits relative weight by ve voting power", async () => {
    await gc.connect(u1).vote(g1.address); // ~1000
    await gc.connect(u2).vote(g2.address); // ~500

    const w1 = await gc.relativeWeight(g1.address);
    const w2 = await gc.relativeWeight(g2.address);
    // g1 should be ~2x g2; the two shares sum to ~1e18
    expect(w1 > w2).to.equal(true);
    const sum = w1 + w2;
    expect(sum >= 999999999000000000n && sum <= 1000000000000000000n).to.equal(true);
  });

  it("re-voting moves a user's full weight", async () => {
    await gc.connect(u1).vote(g1.address);
    await gc.connect(u1).vote(g2.address); // move it
    expect(await gc.relativeWeight(g1.address)).to.equal(0n);
    expect(await gc.relativeWeight(g2.address)).to.equal(1000000000000000000n); // 100%
  });

  it("rejects voting on an unregistered gauge", async () => {
    await expect(gc.connect(u1).vote(admin.address)).to.be.revertedWith("no gauge");
  });
});
