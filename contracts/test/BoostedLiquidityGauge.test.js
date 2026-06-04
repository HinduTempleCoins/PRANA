const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const MAX = 1_000_000; // ve maxLock in seconds (long, so decay is small over the test window)

describe("BoostedLiquidityGauge", function () {
  async function deploy() {
    const [admin, alice, bob] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const stakeT = await Mock.deploy("LP", "LP");
    const rewardT = await Mock.deploy("Rew", "REW");
    const veT = await Mock.deploy("Gov", "GOV");

    const VE = await ethers.getContractFactory("VoteEscrow");
    const ve = await VE.deploy(await veT.getAddress(), MAX);

    const G = await ethers.getContractFactory("BoostedLiquidityGauge");
    const gauge = await G.deploy(
      await stakeT.getAddress(),
      await rewardT.getAddress(),
      await ve.getAddress(),
      admin.address
    );

    for (const u of [alice, bob]) {
      await stakeT.mint(u.address, 1_000_000n);
      await stakeT.connect(u).approve(await gauge.getAddress(), ethers.MaxUint256);
      await veT.mint(u.address, 1_000_000n);
      await veT.connect(u).approve(await ve.getAddress(), ethers.MaxUint256);
    }
    await rewardT.mint(admin.address, 100_000_000n);
    await rewardT.connect(admin).approve(await gauge.getAddress(), ethers.MaxUint256);

    return { admin, alice, bob, stakeT, rewardT, veT, ve, gauge };
  }

  it("boosted staker accrues more than an equal unboosted staker", async () => {
    const { admin, alice, bob, ve, gauge } = await loadFixture(deploy);

    // Alice locks max ve (full boost potential); Bob holds none.
    await ve.connect(alice).lock(1_000_000n, MAX);

    // Equal raw deposits.
    await gauge.connect(alice).stake(1000n);
    await gauge.connect(bob).stake(1000n);

    // Refresh both working balances now that totals exist (re-stake 0 not allowed; use kick path
    // is only for lowering — instead just read current working balances).
    const wbAlice = await gauge.workingBalanceOf(alice.address);
    const wbBob = await gauge.workingBalanceOf(bob.address);

    // Alice (boosted) should have a strictly larger working balance than Bob (floor only).
    expect(wbAlice > wbBob).to.equal(true);
    // Bob is at the 0.4 floor.
    expect(wbBob).to.equal((1000n * 40n) / 100n);

    await gauge.connect(admin).notifyRewardAmount(100_000n, 10_000);
    await time.increase(5000);

    const earnedAlice = await gauge.earned(alice.address);
    const earnedBob = await gauge.earned(bob.address);
    expect(earnedAlice > earnedBob).to.equal(true);

    // Ratio of accrual should match ratio of working balances (within rounding).
    // earnedAlice/earnedBob ≈ wbAlice/wbBob.
    const lhs = earnedAlice * wbBob;
    const rhs = earnedBob * wbAlice;
    const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
    expect(diff <= rhs / 1000n + 1000n).to.equal(true);
  });

  it("kick removes a stale boost after the ve lock expires", async () => {
    const { admin, alice, bob, ve, gauge } = await loadFixture(deploy);

    // Short lock so the ve weight decays to 0 within the test window.
    await ve.connect(alice).lock(1_000_000n, 2000);

    await gauge.connect(alice).stake(1000n);
    const boostedWB = await gauge.workingBalanceOf(alice.address);
    expect(boostedWB > (1000n * 40n) / 100n).to.equal(true); // above floor

    // Advance past lock end → ve.balanceOf(alice) becomes 0, but stored working balance is stale.
    await time.increase(3000);
    expect(await ve.balanceOf(alice.address)).to.equal(0n);
    expect(await gauge.workingBalanceOf(alice.address)).to.equal(boostedWB); // still stale

    // Anyone kicks Alice → working balance drops to the 0.4 floor.
    await expect(gauge.connect(bob).kick(alice.address)).to.emit(gauge, "Kicked");
    expect(await gauge.workingBalanceOf(alice.address)).to.equal((1000n * 40n) / 100n);

    // Kicking again (nothing to remove) reverts.
    await expect(gauge.connect(bob).kick(alice.address)).to.be.revertedWithCustomError(
      gauge,
      "NothingToKick"
    );
  });

  it("fee-on-transfer stake token does NOT over-credit (balance-delta accounting)", async () => {
    const { admin, alice, ve } = await loadFixture(deploy);
    const FoT = await ethers.getContractFactory("FeeOnTransferToken");
    const fee = await FoT.deploy("FeeLP", "FLP", 100); // 1% fee
    const Mock = await ethers.getContractFactory("MockERC20");
    const rewardT = await Mock.deploy("Rew", "REW");

    const G = await ethers.getContractFactory("BoostedLiquidityGauge");
    const gauge = await G.deploy(
      await fee.getAddress(),
      await rewardT.getAddress(),
      await ve.getAddress(),
      admin.address
    );

    await fee.mint(alice.address, 1_000_000n);
    await fee.connect(alice).approve(await gauge.getAddress(), ethers.MaxUint256);

    const gAddr = await gauge.getAddress();
    await gauge.connect(alice).stake(1000n);

    // Gauge actually received only 990 (1% fee burned). Credit must equal received, not 1000.
    const actuallyHeld = await fee.balanceOf(gAddr);
    expect(actuallyHeld).to.equal(990n);
    expect(await gauge.balanceOf(alice.address)).to.equal(990n);
    expect(await gauge.totalSupply()).to.equal(990n);
  });

  it("only the distributor can notify rewards", async () => {
    const { alice, gauge } = await loadFixture(deploy);
    await expect(gauge.connect(alice).notifyRewardAmount(1n, 1)).to.be.revertedWithCustomError(
      gauge,
      "NotDistributor"
    );
  });

  it("lets a staker withdraw raw principal and updates working supply", async () => {
    const { alice, gauge } = await loadFixture(deploy);
    await gauge.connect(alice).stake(1000n);
    await gauge.connect(alice).withdraw(400n);
    expect(await gauge.balanceOf(alice.address)).to.equal(600n);
    expect(await gauge.totalSupply()).to.equal(600n);
    // Working balance recomputed against new deposit; unboosted floor = 0.4 * 600.
    expect(await gauge.workingBalanceOf(alice.address)).to.equal((600n * 40n) / 100n);
  });
});
