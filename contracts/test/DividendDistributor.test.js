const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DividendDistributor", function () {
  let share, reward, dist, admin, a, b;

  beforeEach(async () => {
    [admin, a, b] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    share = await Mock.deploy("Equity", "A");
    reward = await Mock.deploy("Fees", "FEE");
    const D = await ethers.getContractFactory("DividendDistributor");
    dist = await D.deploy(await share.getAddress(), await reward.getAddress());

    await share.mint(a.address, 1000n);
    await share.mint(b.address, 1000n);
    await reward.mint(admin.address, 100000n);
    await share.connect(a).approve(await dist.getAddress(), 1000n);
    await share.connect(b).approve(await dist.getAddress(), 1000n);
    await reward.connect(admin).approve(await dist.getAddress(), 100000n);
  });

  it("splits a distribution pro-rata to staked shares", async () => {
    await dist.connect(a).stake(300n); // a:300
    await dist.connect(b).stake(100n); // b:100  (total 400)
    await dist.connect(admin).distribute(800n); // 2 per share
    expect(await dist.claimable(a.address)).to.equal(600n);
    expect(await dist.claimable(b.address)).to.equal(200n);

    await dist.connect(a).claim();
    expect(await reward.balanceOf(a.address)).to.equal(600n);
    expect(await dist.claimable(a.address)).to.equal(0n);
  });

  it("only rewards shares staked at distribution time", async () => {
    await dist.connect(a).stake(100n);
    await dist.connect(admin).distribute(100n); // all to a
    await dist.connect(b).stake(100n);          // b joins AFTER
    expect(await dist.claimable(a.address)).to.equal(100n);
    expect(await dist.claimable(b.address)).to.equal(0n);
  });

  it("lets a staker unstake and keep accrued rewards", async () => {
    await dist.connect(a).stake(100n);
    await dist.connect(admin).distribute(50n);
    await dist.connect(a).unstake(100n);
    expect(await share.balanceOf(a.address)).to.equal(1000n);
    expect(await dist.claimable(a.address)).to.equal(50n);
  });
});
