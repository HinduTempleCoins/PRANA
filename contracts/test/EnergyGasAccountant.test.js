const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ACC = 10n ** 18n;

describe("EnergyGasAccountant (Prana model)", function () {
  let token, ega, admin, user;
  const RATE = ACC;          // 1 energy per staked unit per second
  const MAXPER = 100n * ACC; // cap = 100 * staked

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Stake", "STK");
    const E = await ethers.getContractFactory("EnergyGasAccountant");
    ega = await E.deploy(await token.getAddress(), RATE, MAXPER);
    await token.mint(user.address, 100n);
    await token.connect(user).approve(await ega.getAddress(), 100n);
  });

  it("regenerates energy proportional to stake, capped, and exposes the rate", async () => {
    await ega.connect(user).stake(10n); // regen 10/sec, cap 1000
    expect(await ega.regenRatePerSecond(user.address)).to.equal(10n);

    await time.increase(50);
    const e = await ega.energyOf(user.address);
    expect(e >= 500n && e <= 520n).to.equal(true); // ~50 * 10

    // way past the cap -> clamped at 1000
    await time.increase(1000);
    expect(await ega.energyOf(user.address)).to.equal(1000n);
  });

  it("spends energy down", async () => {
    await ega.connect(user).stake(10n);
    await time.increase(200); // capped at 1000
    await ega.connect(user).spend(400n);
    const e = await ega.energyOf(user.address);
    expect(e >= 600n && e <= 1000n).to.equal(true);
  });

  it("reverts spending more energy than available", async () => {
    await ega.connect(user).stake(1n); // tiny stake, cap 100
    await expect(ega.connect(user).spend(1000n)).to.be.revertedWith("insufficient energy");
  });
});
