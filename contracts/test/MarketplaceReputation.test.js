const { expect } = require("chai");
const { ethers } = require("hardhat");

// Burn sink (all-lowercase so .withArgs matches ethers' EIP-55-normalized decode).
const SINK = "0x000000000000000000000000000000000000dead";

// Default ladder thresholds from the constructor: Verified=100, Trusted=500, Elite=2000.
// Tier enum: New=0, Verified=1, Trusted=2, Elite=3.
const Tier = { New: 0n, Verified: 1n, Trusted: 2n, Elite: 3n };

describe("MarketplaceReputation", function () {
  let rep, token, admin, marketplace, slasher, seller, stranger;

  const PER_SALE = 50n; // 50 points/sale -> 2 sales reach Verified(100)
  const PER_DISPUTE = 200n;

  beforeEach(async () => {
    [admin, marketplace, slasher, seller, stranger] = await ethers.getSigners();

    const T = await ethers.getContractFactory("MockERC20");
    token = await T.deploy("Bond", "BOND");

    const R = await ethers.getContractFactory("MarketplaceReputation");
    rep = await R.deploy(admin.address, PER_SALE, PER_DISPUTE);

    await rep.connect(admin).grantRole(await rep.REPORTER_ROLE(), marketplace.address);
    await rep.connect(admin).grantRole(await rep.SLASHER_ROLE(), slasher.address);
    await rep.connect(admin).setSlashSink(SINK);

    // Fund the seller with bond tokens.
    await token.mint(seller.address, ethers.parseEther("1000"));
    await token.connect(seller).approve(await rep.getAddress(), ethers.MaxUint256);
  });

  it("raises reputation on a settled sale and emits ReputationUpdated", async () => {
    await expect(rep.connect(marketplace).reportSale(seller.address))
      .to.emit(rep, "ReputationUpdated")
      .withArgs(seller.address, true, PER_SALE, 1, 0);

    const info = await rep.sellerInfo(seller.address);
    expect(info.score).to.equal(PER_SALE);
    expect(info.settledSales).to.equal(1n);
    expect(await rep.tierOf(seller.address)).to.equal(Tier.New);
  });

  it("crosses the Verified threshold and emits TierChanged", async () => {
    await rep.connect(marketplace).reportSale(seller.address); // 50
    // Second sale takes score to 100 == Verified threshold.
    await expect(rep.connect(marketplace).reportSale(seller.address))
      .to.emit(rep, "TierChanged")
      .withArgs(seller.address, Tier.New, Tier.Verified);

    expect(await rep.tierOf(seller.address)).to.equal(Tier.Verified);
    expect(await rep.liveTierOf(seller.address)).to.equal(Tier.Verified);

    // Verified privilege bundle reflected in the views.
    expect(await rep.escrowHoldBpsOf(seller.address)).to.equal(1000);
    expect(await rep.isFeatureEligible(seller.address)).to.equal(false);
  });

  it("climbs to Trusted (featured-eligible) with enough sales", async () => {
    // 10 sales -> 500 -> Trusted.
    for (let i = 0; i < 10; i++) {
      await rep.connect(marketplace).reportSale(seller.address);
    }
    expect(await rep.tierOf(seller.address)).to.equal(Tier.Trusted);
    expect(await rep.isFeatureEligible(seller.address)).to.equal(true);
    expect(await rep.escrowHoldBpsOf(seller.address)).to.equal(500);
  });

  it("lowers reputation on a dispute and drops the tier", async () => {
    // Reach Verified (100), then a 200-point dispute floors well below it.
    await rep.connect(marketplace).reportSale(seller.address);
    await rep.connect(marketplace).reportSale(seller.address);
    expect(await rep.tierOf(seller.address)).to.equal(Tier.Verified);

    await expect(rep.connect(marketplace).reportDispute(seller.address))
      .to.emit(rep, "TierChanged")
      .withArgs(seller.address, Tier.Verified, Tier.New);

    const info = await rep.sellerInfo(seller.address);
    expect(info.score).to.equal(0n); // floored, never underflows
    expect(info.disputes).to.equal(1n);
  });

  it("never lets score underflow below zero on disputes", async () => {
    await rep.connect(marketplace).reportDispute(seller.address);
    const info = await rep.sellerInfo(seller.address);
    expect(info.score).to.equal(0n);
  });

  it("a posted bond can gate a tier's minBond requirement", async () => {
    // Reconfigure Verified to require a 100-token bond on top of score 100.
    await rep
      .connect(admin)
      .setTierConfig(Tier.Verified, 100, ethers.parseEther("100"), 0, 1000, false);

    // Score reaches 100 but no bond yet -> still New.
    await rep.connect(marketplace).reportSale(seller.address);
    await rep.connect(marketplace).reportSale(seller.address);
    expect(await rep.tierOf(seller.address)).to.equal(Tier.New);

    // Post the bond -> promotes to Verified.
    await expect(rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("100")))
      .to.emit(rep, "TierChanged")
      .withArgs(seller.address, Tier.New, Tier.Verified);
    expect(await rep.tierOf(seller.address)).to.equal(Tier.Verified);
  });

  it("slashes a seller's bond and routes it to the sink", async () => {
    await rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("100"));
    const before = await token.balanceOf(SINK);

    await expect(
      rep.connect(slasher).slash(seller.address, ethers.parseEther("40"), ethers.id("fraud"))
    )
      .to.emit(rep, "Slashed")
      .withArgs(seller.address, ethers.parseEther("40"), ethers.getAddress(SINK), ethers.id("fraud"));

    expect(await token.balanceOf(SINK)).to.equal(before + ethers.parseEther("40"));
    const info = await rep.sellerInfo(seller.address);
    expect(info.bond).to.equal(ethers.parseEther("60"));
  });

  it("lets a seller withdraw their own bond", async () => {
    await rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("100"));
    const before = await token.balanceOf(seller.address);
    await expect(rep.connect(seller).withdrawBond(ethers.parseEther("30")))
      .to.emit(rep, "BondWithdrawn")
      .withArgs(seller.address, ethers.parseEther("30"), ethers.parseEther("70"));
    expect(await token.balanceOf(seller.address)).to.equal(before + ethers.parseEther("30"));
  });

  it("reverts withdrawing more bond than posted", async () => {
    await rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("10"));
    await expect(
      rep.connect(seller).withdrawBond(ethers.parseEther("11"))
    ).to.be.revertedWithCustomError(rep, "InsufficientBond");
  });

  it("rejects a bond top-up in a different token", async () => {
    const T2 = await ethers.getContractFactory("MockERC20");
    const token2 = await T2.deploy("Other", "OTH");
    await token2.mint(seller.address, ethers.parseEther("10"));
    await token2.connect(seller).approve(await rep.getAddress(), ethers.MaxUint256);

    await rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("5"));
    await expect(
      rep.connect(seller).postBond(await token2.getAddress(), ethers.parseEther("5"))
    ).to.be.revertedWithCustomError(rep, "BondTokenMismatch");
  });

  it("gates reportSale / reportDispute behind REPORTER_ROLE", async () => {
    await expect(
      rep.connect(stranger).reportSale(seller.address)
    ).to.be.revertedWithCustomError(rep, "AccessControlUnauthorizedAccount");
    await expect(
      rep.connect(stranger).reportDispute(seller.address)
    ).to.be.revertedWithCustomError(rep, "AccessControlUnauthorizedAccount");
  });

  it("gates slash behind SLASHER_ROLE", async () => {
    await rep.connect(seller).postBond(await token.getAddress(), ethers.parseEther("10"));
    await expect(
      rep.connect(stranger).slash(seller.address, 1n, ethers.id("x"))
    ).to.be.revertedWithCustomError(rep, "AccessControlUnauthorizedAccount");
  });

  it("gates admin config behind DEFAULT_ADMIN_ROLE", async () => {
    await expect(
      rep.connect(stranger).setScoring(1n, 1n)
    ).to.be.revertedWithCustomError(rep, "AccessControlUnauthorizedAccount");
    await expect(
      rep.connect(stranger).setTierConfig(Tier.Verified, 1, 0, 0, 0, false)
    ).to.be.revertedWithCustomError(rep, "AccessControlUnauthorizedAccount");
  });

  it("refuses to configure the baseline New tier", async () => {
    await expect(
      rep.connect(admin).setTierConfig(Tier.New, 1, 0, 0, 0, false)
    ).to.be.revertedWithCustomError(rep, "BadTier");
  });

  it("rejects an escrow-hold bps over 10000", async () => {
    await expect(
      rep.connect(admin).setTierConfig(Tier.Verified, 1, 0, 0, 10001, false)
    ).to.be.revertedWithCustomError(rep, "BadBps");
  });

  it("requires a slash sink before slashing", async () => {
    const R = await ethers.getContractFactory("MarketplaceReputation");
    const fresh = await R.deploy(admin.address, PER_SALE, PER_DISPUTE);
    await token.connect(seller).approve(await fresh.getAddress(), ethers.MaxUint256);
    await fresh.connect(seller).postBond(await token.getAddress(), ethers.parseEther("5"));
    await expect(
      fresh.connect(admin).slash(seller.address, 1n, ethers.id("x"))
    ).to.be.revertedWithCustomError(fresh, "SlashSinkUnset");
  });
});
