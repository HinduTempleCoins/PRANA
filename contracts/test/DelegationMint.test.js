const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("DelegationMint", function () {
  const EMISSION = 100n; // reward minted per block

  async function deployFixture() {
    const [admin, alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const stake = await Mock.deploy("Stake", "STK");

    const PoL = await ethers.getContractFactory("PoLToken");
    const reward = await PoL.deploy(admin.address);

    const DM = await ethers.getContractFactory("DelegationMint");
    const dm = await DM.deploy(
      await stake.getAddress(),
      await reward.getAddress(),
      EMISSION
    );

    // contract must hold the minter role on the reward token
    await reward.grantRole(await reward.MINTER_ROLE(), await dm.getAddress());

    for (const u of [alice, bob]) {
      await stake.mint(u.address, 10_000n);
      await stake.connect(u).approve(await dm.getAddress(), 10_000n);
    }

    return { dm, stake, reward, admin, alice, bob };
  }

  it("deploys with expected config", async () => {
    const { dm, stake, reward } = await loadFixture(deployFixture);
    expect(await dm.stakeToken()).to.equal(await stake.getAddress());
    expect(await dm.rewardToken()).to.equal(await reward.getAddress());
    expect(await dm.emissionPerBlock()).to.equal(EMISSION);
  });

  it("reverts delegating zero", async () => {
    const { dm, alice } = await loadFixture(deployFixture);
    await expect(dm.connect(alice).delegate(0n)).to.be.revertedWithCustomError(dm, "ZeroAmount");
  });

  it("delegate pulls stake and tracks weight", async () => {
    const { dm, stake, alice } = await loadFixture(deployFixture);
    await expect(dm.connect(alice).delegate(1000n))
      .to.emit(dm, "Delegated")
      .withArgs(alice.address, 1000n, 1000n);
    expect(await dm.delegatedOf(alice.address)).to.equal(1000n);
    expect(await dm.totalDelegated()).to.equal(1000n);
    expect(await stake.balanceOf(await dm.getAddress())).to.equal(1000n);
  });

  it("pending reward accrues one full emission per block to a sole delegator", async () => {
    const { dm, alice } = await loadFixture(deployFixture);
    await dm.connect(alice).delegate(1000n);
    await mine(5);
    // 5 blocks * 100 emission, sole delegator gets all
    expect(await dm.pendingReward(alice.address)).to.equal(5n * EMISSION);
  });

  it("claim mints accrued reward and zeroes pending", async () => {
    const { dm, reward, alice } = await loadFixture(deployFixture);
    await dm.connect(alice).delegate(1000n);
    await mine(3);
    // claim() itself advances one more block when mined
    const before = await dm.pendingReward(alice.address); // 3 blocks
    expect(before).to.equal(3n * EMISSION);

    await dm.connect(alice).claim(); // executes in a new block -> 4 blocks accrued
    expect(await reward.balanceOf(alice.address)).to.equal(4n * EMISSION);
    expect(await dm.pendingReward(alice.address)).to.equal(0n);
  });

  it("claim with no delegation returns/pays zero", async () => {
    const { dm, reward, bob } = await loadFixture(deployFixture);
    await dm.connect(bob).claim();
    expect(await reward.balanceOf(bob.address)).to.equal(0n);
    expect(await dm.pendingReward(bob.address)).to.equal(0n);
  });

  it("splits emission pro-rata across delegators", async () => {
    const { dm, alice, bob } = await loadFixture(deployFixture);
    // both delegate in consecutive blocks; isolate a window where both are active
    await dm.connect(alice).delegate(1000n);
    await dm.connect(bob).delegate(3000n); // alice already earned 1 solo block here

    const aBefore = await dm.pendingReward(alice.address);

    await mine(10); // 10 blocks with both active: alice 1/4, bob 3/4
    const aGain = (await dm.pendingReward(alice.address)) - aBefore;
    const bTotal = await dm.pendingReward(bob.address);

    // over the shared window: alice 25%, bob 75% of 10*100 = 1000
    expect(aGain).to.equal(250n);
    expect(bTotal).to.equal(750n);
  });

  it("undelegate drops weight immediately and returns stake", async () => {
    const { dm, stake, alice } = await loadFixture(deployFixture);
    await dm.connect(alice).delegate(1000n);
    await mine(2);

    const balBefore = await stake.balanceOf(alice.address);
    await expect(dm.connect(alice).undelegate(400n))
      .to.emit(dm, "Undelegated")
      .withArgs(alice.address, 400n, 600n);

    expect(await dm.delegatedOf(alice.address)).to.equal(600n);
    expect(await dm.totalDelegated()).to.equal(600n);
    expect(await stake.balanceOf(alice.address)).to.equal(balBefore + 400n);
  });

  it("undelegate preserves already-accrued reward", async () => {
    const { dm, reward, alice } = await loadFixture(deployFixture);
    await dm.connect(alice).delegate(1000n);
    await mine(4);
    await dm.connect(alice).undelegate(1000n); // fully exit (advances a block -> 5 accrued)
    expect(await dm.delegatedOf(alice.address)).to.equal(0n);

    await dm.connect(alice).claim();
    expect(await reward.balanceOf(alice.address)).to.equal(5n * EMISSION);
  });

  it("reverts undelegating zero or more than delegated", async () => {
    const { dm, alice } = await loadFixture(deployFixture);
    await dm.connect(alice).delegate(1000n);
    await expect(dm.connect(alice).undelegate(0n)).to.be.revertedWithCustomError(dm, "ZeroAmount");
    await expect(dm.connect(alice).undelegate(1001n)).to.be.revertedWithCustomError(
      dm,
      "InsufficientDelegation"
    );
  });

  it("no emission is back-paid for blocks with zero total stake", async () => {
    const { dm, alice } = await loadFixture(deployFixture);
    await mine(20); // nothing delegated yet
    await dm.connect(alice).delegate(1000n);
    await mine(3);
    // only the 3 active blocks count, the 20 idle blocks emit nothing to anyone
    expect(await dm.pendingReward(alice.address)).to.equal(3n * EMISSION);
  });
});
