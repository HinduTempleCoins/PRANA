const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FrontEndFeeRebate", function () {
  let rebate, token, admin, marketplace, burner, frontEnd, trader, stranger;

  const MAX_BPS = 2000; // 20% ceiling
  const REBATE_BPS = 1000; // front-end's 10% rebate rate
  const RECIPIENT = "0x00000000000000000000000000000000000000aa";

  beforeEach(async () => {
    [admin, marketplace, burner, frontEnd, trader, stranger] = await ethers.getSigners();

    const T = await ethers.getContractFactory("MockERC20");
    token = await T.deploy("Rebate", "RBT");

    const R = await ethers.getContractFactory("FrontEndFeeRebate");
    rebate = await R.deploy(admin.address, await token.getAddress(), MAX_BPS);

    await rebate.connect(admin).grantRole(await rebate.REPORTER_ROLE(), marketplace.address);
    await rebate.connect(admin).grantRole(await rebate.BURNER_ROLE(), burner.address);

    // Fund the rebate vault generously.
    await token.mint(admin.address, ethers.parseEther("1000"));
    await token.connect(admin).approve(await rebate.getAddress(), ethers.MaxUint256);
    await rebate.connect(admin).fund(ethers.parseEther("1000"));
  });

  async function setupAllowlistedFrontEnd(burnCredit = ethers.parseEther("1000")) {
    await rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await rebate.connect(admin).setAllowlisted(frontEnd.address, true);
    if (burnCredit > 0n) {
      await rebate.connect(burner).creditBurn(frontEnd.address, burnCredit);
    }
  }

  it("registers a front-end and emits FrontEndRegistered", async () => {
    await expect(rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS))
      .to.emit(rebate, "FrontEndRegistered")
      .withArgs(frontEnd.address, ethers.getAddress(RECIPIENT), REBATE_BPS);

    const info = await rebate.frontEndInfo(frontEnd.address);
    expect(info.registered).to.equal(true);
    expect(info.allowlisted).to.equal(false);
    expect(info.rebateBps).to.equal(REBATE_BPS);
  });

  it("rejects a double registration", async () => {
    await rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await expect(
      rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS)
    ).to.be.revertedWithCustomError(rebate, "AlreadyRegistered");
  });

  it("caps the rebate bps at maxRebateBps on register", async () => {
    await expect(
      rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, MAX_BPS + 1)
    ).to.be.revertedWithCustomError(rebate, "BadBps");
  });

  it("credits a rebate on a trade routed through a registered, allowlisted front-end", async () => {
    await setupAllowlistedFrontEnd();
    const fee = ethers.parseEther("100");
    const expected = (fee * BigInt(REBATE_BPS)) / 10000n; // 10 RBT

    await expect(rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, fee))
      .to.emit(rebate, "RebateCredited")
      .withArgs(trader.address, frontEnd.address, fee, expected);

    expect(await rebate.claimable(trader.address)).to.equal(expected);
    expect(await rebate.totalOwed()).to.equal(expected);

    // Burn credit was debited by the rebate amount.
    const info = await rebate.frontEndInfo(frontEnd.address);
    expect(info.burnCredit).to.equal(ethers.parseEther("1000") - expected);
  });

  it("lets the trader claim the credited rebate", async () => {
    await setupAllowlistedFrontEnd();
    const fee = ethers.parseEther("100");
    const expected = (fee * BigInt(REBATE_BPS)) / 10000n;
    await rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, fee);

    const before = await token.balanceOf(trader.address);
    await expect(rebate.connect(trader).claim())
      .to.emit(rebate, "RebateClaimed")
      .withArgs(trader.address, expected);

    expect(await token.balanceOf(trader.address)).to.equal(before + expected);
    expect(await rebate.claimable(trader.address)).to.equal(0n);
    expect(await rebate.totalOwed()).to.equal(0n);
  });

  it("gives no rebate when the front-end is unregistered", async () => {
    await expect(
      rebate.connect(marketplace).reportTrade(stranger.address, trader.address, ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(rebate, "NotRegistered");
  });

  it("gives no rebate when the front-end is registered but not allowlisted", async () => {
    await rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await rebate.connect(burner).creditBurn(frontEnd.address, ethers.parseEther("100"));
    await expect(
      rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(rebate, "NotAllowlisted");
  });

  it("binds the rebate to Proof-of-Burn: caps the rebate at remaining burn credit", async () => {
    // Only 3 RBT of burn credit, but a 100-fee trade would otherwise rebate 10.
    await setupAllowlistedFrontEnd(ethers.parseEther("3"));
    const fee = ethers.parseEther("100");

    await expect(rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, fee))
      .to.emit(rebate, "RebateCredited")
      .withArgs(trader.address, frontEnd.address, fee, ethers.parseEther("3"));

    expect(await rebate.claimable(trader.address)).to.equal(ethers.parseEther("3"));
    const info = await rebate.frontEndInfo(frontEnd.address);
    expect(info.burnCredit).to.equal(0n);
  });

  it("credits zero (no revert) when the front-end has no burn credit", async () => {
    await setupAllowlistedFrontEnd(0n);
    await expect(rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, ethers.parseEther("100")))
      .to.emit(rebate, "RebateCredited")
      .withArgs(trader.address, frontEnd.address, ethers.parseEther("100"), 0n);
    expect(await rebate.claimable(trader.address)).to.equal(0n);
  });

  it("reverts a claim when nothing is owed", async () => {
    await expect(rebate.connect(trader).claim()).to.be.revertedWithCustomError(
      rebate,
      "NothingToClaim"
    );
  });

  it("reverts a trade report when the vault cannot cover the rebate", async () => {
    // Fresh contract with a tiny vault.
    const R = await ethers.getContractFactory("FrontEndFeeRebate");
    const r2 = await R.deploy(admin.address, await token.getAddress(), MAX_BPS);
    await r2.connect(admin).grantRole(await r2.REPORTER_ROLE(), marketplace.address);
    await r2.connect(admin).grantRole(await r2.BURNER_ROLE(), burner.address);
    await token.mint(admin.address, ethers.parseEther("1")); // beforeEach spent admin's balance funding `rebate`
    await token.connect(admin).approve(await r2.getAddress(), ethers.MaxUint256);
    await r2.connect(admin).fund(ethers.parseEther("1")); // only 1 RBT

    await r2.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await r2.connect(admin).setAllowlisted(frontEnd.address, true);
    await r2.connect(burner).creditBurn(frontEnd.address, ethers.parseEther("1000"));

    // 100-fee trade -> 10 RBT rebate, but vault only has 1.
    await expect(
      r2.connect(marketplace).reportTrade(frontEnd.address, trader.address, ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(r2, "InsufficientVault");
  });

  it("gates reportTrade behind REPORTER_ROLE", async () => {
    await setupAllowlistedFrontEnd();
    await expect(
      rebate.connect(stranger).reportTrade(frontEnd.address, trader.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(rebate, "AccessControlUnauthorizedAccount");
  });

  it("gates creditBurn behind BURNER_ROLE", async () => {
    await rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await expect(
      rebate.connect(stranger).creditBurn(frontEnd.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(rebate, "AccessControlUnauthorizedAccount");
  });

  it("gates setAllowlisted / setMaxRebateBps behind DEFAULT_ADMIN_ROLE", async () => {
    await rebate.connect(frontEnd).registerFrontEnd(RECIPIENT, REBATE_BPS);
    await expect(
      rebate.connect(stranger).setAllowlisted(frontEnd.address, true)
    ).to.be.revertedWithCustomError(rebate, "AccessControlUnauthorizedAccount");
    await expect(
      rebate.connect(stranger).setMaxRebateBps(100)
    ).to.be.revertedWithCustomError(rebate, "AccessControlUnauthorizedAccount");
  });

  it("sweeps only unreserved vault funds, never owed rebates", async () => {
    await setupAllowlistedFrontEnd();
    const fee = ethers.parseEther("100");
    const owed = (fee * BigInt(REBATE_BPS)) / 10000n; // 10 owed
    await rebate.connect(marketplace).reportTrade(frontEnd.address, trader.address, fee);

    // Vault = 1000, owed = 10, so available = 990.
    expect(await rebate.availableVault()).to.equal(ethers.parseEther("990"));
    await expect(
      rebate.connect(admin).sweep(stranger.address, ethers.parseEther("991"))
    ).to.be.revertedWithCustomError(rebate, "InsufficientVault");

    await rebate.connect(admin).sweep(stranger.address, ethers.parseEther("990"));
    expect(await rebate.availableVault()).to.equal(0n);
    // The 10 owed is still claimable.
    expect(await rebate.totalOwed()).to.equal(owed);
    await rebate.connect(trader).claim();
    expect(await token.balanceOf(trader.address)).to.equal(owed);
  });
});
