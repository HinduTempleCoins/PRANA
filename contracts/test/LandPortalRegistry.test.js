const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("LandPortalRegistry", function () {
  const DEST_A = ethers.id("dest:plaza");
  const DEST_B = ethers.id("dest:market");
  const FUND = 1_000_000n;

  async function deployFixture() {
    const [admin, alice, bob, funder, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const reward = await Mock.deploy("Reward", "RWD");

    const Reg = await ethers.getContractFactory("LandPortalRegistry");
    const reg = await Reg.deploy("Parcels", "LAND", await reward.getAddress(), admin.address);

    // parcels: 1 -> alice, 2 -> bob
    await reg.mintParcel(alice.address, 1);
    await reg.mintParcel(bob.address, 2);

    // allowlist + funding budget for the funder
    await reg.setDestinationApproval(DEST_A, true);
    await reward.mint(funder.address, 10n * FUND);
    await reward.connect(funder).approve(await reg.getAddress(), ethers.MaxUint256);

    return { reg, reward, admin, alice, bob, funder, outsider };
  }

  it("deploys with expected config", async () => {
    const { reg, reward } = await loadFixture(deployFixture);
    expect(await reg.rewardToken()).to.equal(await reward.getAddress());
    expect(await reg.epoch()).to.equal(0n);
  });

  it("owner can set an approved destination; others / unapproved revert", async () => {
    const { reg, alice, bob } = await loadFixture(deployFixture);

    await expect(reg.connect(alice).setDestination(1, DEST_A))
      .to.emit(reg, "DestinationSet")
      .withArgs(1, DEST_A);
    expect(await reg.destinationOf(1)).to.equal(DEST_A);

    // non-owner of the parcel cannot set it
    await expect(reg.connect(bob).setDestination(1, DEST_A))
      .to.be.revertedWithCustomError(reg, "NotParcelOwner");

    // unapproved destination reverts
    await expect(reg.connect(alice).setDestination(1, DEST_B))
      .to.be.revertedWithCustomError(reg, "DestinationNotApproved");
  });

  it("funding accrues into pendingPool", async () => {
    const { reg, funder } = await loadFixture(deployFixture);
    await expect(reg.connect(funder).fundPool(FUND))
      .to.emit(reg, "PoolFunded")
      .withArgs(funder.address, FUND, FUND);
    expect(await reg.pendingPool()).to.equal(FUND);
  });

  it("distributes an epoch pro-rata to traffic and pays pull-based claims", async () => {
    const { reg, reward, alice, bob, funder } = await loadFixture(deployFixture);

    await reg.connect(funder).fundPool(FUND);
    // alice parcel 300 visits, bob parcel 100 visits -> 3:1 split
    await reg.postTraffic([1, 2], [300, 100]);
    expect(await reg.currentEpochVisits()).to.equal(400n);

    await expect(reg.finalizeEpoch()).to.emit(reg, "EpochFinalized");
    expect(await reg.epoch()).to.equal(1n);

    // 400 visits over 1_000_000 => 2500 per visit (exact, no dust)
    expect(await reg.claimable(1)).to.equal(300n * 2500n); // 750_000
    expect(await reg.claimable(2)).to.equal(100n * 2500n); // 250_000

    const aBefore = await reward.balanceOf(alice.address);
    await expect(reg.connect(alice).claim(1))
      .to.emit(reg, "RewardClaimed")
      .withArgs(1, alice.address, 750_000n);
    expect(await reward.balanceOf(alice.address)).to.equal(aBefore + 750_000n);

    await reg.connect(bob).claim(2);
    expect(await reward.balanceOf(bob.address)).to.equal(250_000n);

    // double-claim yields nothing
    await expect(reg.connect(alice).claim(1)).to.be.revertedWithCustomError(reg, "ZeroAmount");
  });

  it("accumulates across multiple epochs (rollover)", async () => {
    const { reg, alice, bob, funder } = await loadFixture(deployFixture);

    // epoch 0: only alice gets traffic, full pool to her
    await reg.connect(funder).fundPool(FUND);
    await reg.postTraffic([1], [100]);
    await reg.finalizeEpoch();
    expect(await reg.claimable(1)).to.equal(FUND); // 100 visits * (FUND/100)
    expect(await reg.claimable(2)).to.equal(0n);

    // epoch 1: fund again, both get equal traffic -> equal split this epoch
    await reg.connect(funder).fundPool(FUND);
    await reg.postTraffic([1, 2], [50, 50]);
    await reg.finalizeEpoch();

    // alice carries epoch-0 (FUND) + half of epoch-1 (FUND/2); bob gets half of epoch-1
    expect(await reg.claimable(1)).to.equal(FUND + FUND / 2n);
    expect(await reg.claimable(2)).to.equal(FUND / 2n);
  });

  it("finalize reverts without traffic or without pool", async () => {
    const { reg, funder } = await loadFixture(deployFixture);

    await reg.connect(funder).fundPool(FUND);
    await expect(reg.finalizeEpoch()).to.be.revertedWithCustomError(reg, "NoTraffic");

    // fresh fixture path: traffic but no pool
    const { reg: reg2 } = await loadFixture(deployFixture);
    await reg2.postTraffic([1], [10]);
    await expect(reg2.finalizeEpoch()).to.be.revertedWithCustomError(reg2, "NoPendingPool");
  });

  it("only the oracle can post traffic / finalize", async () => {
    const { reg, outsider } = await loadFixture(deployFixture);
    await expect(reg.connect(outsider).postTraffic([1], [10]))
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
    await expect(reg.connect(outsider).finalizeEpoch())
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
  });

  it("posting traffic for a non-existent parcel reverts", async () => {
    const { reg } = await loadFixture(deployFixture);
    await expect(reg.postTraffic([99], [10]))
      .to.be.revertedWithCustomError(reg, "UnknownParcel");
  });

  it("postTraffic length mismatch reverts", async () => {
    const { reg } = await loadFixture(deployFixture);
    await expect(reg.postTraffic([1, 2], [10]))
      .to.be.revertedWithCustomError(reg, "LengthMismatch");
  });
});
