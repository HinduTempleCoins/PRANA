const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("ReputationRegistry (AG2)", function () {
  async function deploy() {
    const [admin, treasury, alice, bob, scorer, slasher, outsider] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

    const Rep = await ethers.getContractFactory("ReputationRegistry");
    const rep = await Rep.deploy(await prana.getAddress(), treasury.address, admin.address);

    // dedicated role holders
    await rep.grantRole(await rep.SCORER_ROLE(), scorer.address);
    await rep.grantRole(await rep.SLASHER_ROLE(), slasher.address);

    // fund alice/bob with stake token
    for (const a of [alice, bob]) {
      await prana.mint(a.address, 1000n);
      await prana.connect(a).approve(await rep.getAddress(), ethers.MaxUint256);
    }
    return { rep, prana, admin, treasury, alice, bob, scorer, slasher, outsider };
  }

  it("reverts zero admin / treasury", async () => {
    const [admin, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");
    const Rep = await ethers.getContractFactory("ReputationRegistry");
    await expect(Rep.deploy(await prana.getAddress(), treasury.address, ethers.ZeroAddress)).to.be.revertedWith("admin=0");
    await expect(Rep.deploy(await prana.getAddress(), ethers.ZeroAddress, admin.address)).to.be.revertedWith("treasury=0");
  });

  it("gain raises soulbound score; only SCORER", async () => {
    const { rep, alice, scorer, outsider } = await loadFixture(deploy);
    await expect(rep.connect(outsider).gain(alice.address, 10n)).to.be.revertedWithCustomError(
      rep,
      "AccessControlUnauthorizedAccount"
    );
    await expect(rep.connect(scorer).gain(alice.address, 10n))
      .to.emit(rep, "ReputationGained")
      .withArgs(alice.address, 10n, 10n);
    expect(await rep.reputationOf(alice.address)).to.equal(10n);
    await expect(rep.connect(scorer).gain(alice.address, 0n)).to.be.revertedWithCustomError(rep, "ZeroAmount");
  });

  it("dock lowers score saturating at zero; only SLASHER", async () => {
    const { rep, alice, scorer, slasher } = await loadFixture(deploy);
    await rep.connect(scorer).gain(alice.address, 10n);
    await expect(rep.connect(slasher).dock(alice.address, 3n))
      .to.emit(rep, "ReputationDocked")
      .withArgs(alice.address, 3n, 7n);
    expect(await rep.reputationOf(alice.address)).to.equal(7n);
    // saturating
    await rep.connect(slasher).dock(alice.address, 100n);
    expect(await rep.reputationOf(alice.address)).to.equal(0n);
  });

  it("tier thresholds bucket the score; must be ascending", async () => {
    const { rep, admin, alice, scorer } = await loadFixture(deploy);
    await expect(rep.connect(admin).setTierThresholds([10n, 5n])).to.be.revertedWithCustomError(
      rep,
      "ThresholdsNotAscending"
    );
    await expect(rep.connect(admin).setTierThresholds([10n, 50n, 100n]))
      .to.emit(rep, "TierThresholdsSet");
    expect(await rep.tierThresholds()).to.deep.equal([10n, 50n, 100n]);

    expect(await rep.tierOf(alice.address)).to.equal(0n); // 0 score
    await rep.connect(scorer).gain(alice.address, 10n);
    expect(await rep.tierOf(alice.address)).to.equal(1n);
    await rep.connect(scorer).gain(alice.address, 45n); // 55
    expect(await rep.tierOf(alice.address)).to.equal(2n);
    await rep.connect(scorer).gain(alice.address, 50n); // 105
    expect(await rep.tierOf(alice.address)).to.equal(3n);
  });

  it("stake / unstake / slash the good-faith bond", async () => {
    const { rep, prana, treasury, alice, slasher } = await loadFixture(deploy);
    await expect(rep.connect(alice).stake(100n)).to.emit(rep, "Staked").withArgs(alice.address, 100n, 100n);
    expect(await rep.stakeOf(alice.address)).to.equal(100n);

    await expect(rep.connect(alice).unstake(40n)).to.emit(rep, "Unstaked").withArgs(alice.address, 40n, 60n);
    expect(await rep.stakeOf(alice.address)).to.equal(60n);

    const tBefore = await prana.balanceOf(treasury.address);
    await expect(rep.connect(slasher).slashStake(alice.address, 25n))
      .to.emit(rep, "StakeSlashed")
      .withArgs(alice.address, 25n, 35n, treasury.address);
    expect(await rep.stakeOf(alice.address)).to.equal(35n);
    expect((await prana.balanceOf(treasury.address)) - tBefore).to.equal(25n);

    await expect(rep.connect(alice).unstake(1000n)).to.be.revertedWithCustomError(rep, "AmountExceedsStake");
    await expect(rep.connect(slasher).slashStake(alice.address, 1000n)).to.be.revertedWithCustomError(
      rep,
      "AmountExceedsStake"
    );
  });

  it("stake disabled when no stake token", async () => {
    const [admin, treasury, alice] = await ethers.getSigners();
    const Rep = await ethers.getContractFactory("ReputationRegistry");
    const rep = await Rep.deploy(ethers.ZeroAddress, treasury.address, admin.address);
    await expect(rep.connect(alice).stake(1n)).to.be.revertedWithCustomError(rep, "StakeDisabled");
  });
});
