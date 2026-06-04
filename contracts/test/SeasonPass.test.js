const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonPass", function () {
  let token, pass, admin, backend, player, outsider;

  // Tier config: tier 0 unlocks at 100 XP (reward 50), tier 1 at 300 XP (reward 200).
  const THRESHOLDS = [100n, 300n];
  const REWARDS = [50n, 200n];
  const FUNDING = 100000n;

  beforeEach(async () => {
    [admin, backend, player, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Reward", "RWD");

    const Pass = await ethers.getContractFactory("SeasonPass");
    pass = await Pass.deploy(
      await token.getAddress(),
      THRESHOLDS,
      REWARDS,
      admin.address
    );

    // Fund the pass so it can pay rewards, and let the backend grant XP.
    await token.mint(await pass.getAddress(), FUNDING);
    await pass.grantRole(await pass.GRANTER_ROLE(), backend.address);
  });

  it("addXp accrues season XP (granter-only)", async () => {
    await expect(pass.connect(backend).addXp(player.address, 60n))
      .to.emit(pass, "XpAdded")
      .withArgs(0n, player.address, 60n, 60n);

    await pass.connect(backend).addXp(player.address, 50n);
    expect(await pass.xpOf(player.address)).to.equal(110n);

    // non-granter cannot add XP
    await expect(
      pass.connect(outsider).addXp(player.address, 10n)
    ).to.be.revertedWithCustomError(pass, "AccessControlUnauthorizedAccount");
  });

  it("claimTier pays the reward once the threshold is met", async () => {
    await pass.connect(backend).addXp(player.address, 150n); // past tier 0 (100)

    const before = await token.balanceOf(player.address);
    await expect(pass.connect(player).claimTier(0))
      .to.emit(pass, "TierClaimed")
      .withArgs(0n, player.address, 0n, 50n);

    expect(await token.balanceOf(player.address)).to.equal(before + 50n);
    expect(await pass.hasClaimed(player.address, 0)).to.equal(true);
  });

  it("reverts when claiming a tier whose threshold is not reached", async () => {
    await pass.connect(backend).addXp(player.address, 150n); // enough for tier 0, not tier 1

    await expect(
      pass.connect(player).claimTier(1)
    ).to.be.revertedWith("threshold not met");
  });

  it("reverts on a double-claim of the same tier", async () => {
    await pass.connect(backend).addXp(player.address, 150n);
    await pass.connect(player).claimTier(0);

    await expect(
      pass.connect(player).claimTier(0)
    ).to.be.revertedWith("already claimed");
  });

  it("startNewSeason resets XP and claims (non-rollover)", async () => {
    await pass.connect(backend).addXp(player.address, 350n);
    await pass.connect(player).claimTier(1); // claim tier 1 in season 0
    expect(await pass.xpOf(player.address)).to.equal(350n);

    // Admin starts a fresh season with new config.
    await expect(pass.startNewSeason([200n], [10n]))
      .to.emit(pass, "SeasonStarted");
    expect(await pass.seasonId()).to.equal(1n);

    // Prior XP no longer counts; claims are reset.
    expect(await pass.xpOf(player.address)).to.equal(0n);
    expect(await pass.hasClaimed(player.address, 1)).to.equal(false);

    // With reset XP, claiming reverts until the new threshold is met.
    await expect(
      pass.connect(player).claimTier(0)
    ).to.be.revertedWith("threshold not met");

    // Re-accrue under the new season and claim tier 0 of season 1.
    await pass.connect(backend).addXp(player.address, 200n);
    await expect(pass.connect(player).claimTier(0))
      .to.emit(pass, "TierClaimed")
      .withArgs(1n, player.address, 0n, 10n);
  });

  it("reverts when claiming an out-of-range tier", async () => {
    await pass.connect(backend).addXp(player.address, 500n);
    await expect(
      pass.connect(player).claimTier(5)
    ).to.be.revertedWith("invalid tier");
  });
});
