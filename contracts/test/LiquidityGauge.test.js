const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("LiquidityGauge", function () {
  let stakeT, rewardT, gauge, admin, user;

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    stakeT = await Mock.deploy("LP", "LP");
    rewardT = await Mock.deploy("Rew", "REW");
    const G = await ethers.getContractFactory("LiquidityGauge");
    gauge = await G.deploy(await stakeT.getAddress(), await rewardT.getAddress(), admin.address);

    await stakeT.mint(user.address, 100n);
    await stakeT.connect(user).approve(await gauge.getAddress(), 100n);
    await rewardT.mint(admin.address, 1000n);
    await rewardT.connect(admin).approve(await gauge.getAddress(), 1000n);
  });

  it("accrues rewards by stake × time and pays out", async () => {
    await gauge.connect(user).stake(100n);
    await gauge.connect(admin).notifyRewardAmount(1000n, 1000); // ~1 token/sec
    await time.increase(500);
    const earned = await gauge.earned(user.address);
    expect(earned >= 495n && earned <= 505n).to.equal(true);

    await gauge.connect(user).getReward();
    const bal = await rewardT.balanceOf(user.address);
    expect(bal >= 495n && bal <= 510n).to.equal(true);
  });

  it("lets a staker withdraw their LP", async () => {
    await gauge.connect(user).stake(100n);
    await gauge.connect(user).withdraw(40n);
    expect(await stakeT.balanceOf(user.address)).to.equal(40n);
    expect(await gauge.balanceOf(user.address)).to.equal(60n);
  });

  it("only the distributor can notify rewards", async () => {
    await expect(gauge.connect(user).notifyRewardAmount(1n, 1)).to.be.revertedWith("not distributor");
  });
});
