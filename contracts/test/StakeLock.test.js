const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("StakeLock", function () {
  const DUR_SHORT = 1000; // seconds
  const DUR_LONG = 4000;
  const BPS_SHORT = 10_000n; // 1x
  const BPS_LONG = 25_000n; // 2.5x

  async function deployFixture() {
    const [admin, alice, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Lock", "LCK");

    const SL = await ethers.getContractFactory("StakeLock");
    const sl = await SL.deploy(await token.getAddress(), admin.address);

    await sl.setTier(DUR_SHORT, BPS_SHORT);
    await sl.setTier(DUR_LONG, BPS_LONG);

    await token.mint(alice.address, 10_000n);
    await token.connect(alice).approve(await sl.getAddress(), 10_000n);

    return { sl, token, admin, alice, outsider };
  }

  it("admin configures tiers; non-admin cannot", async () => {
    const { sl, outsider } = await loadFixture(deployFixture);
    expect(await sl.multiplierBps(DUR_SHORT)).to.equal(BPS_SHORT);
    expect(await sl.multiplierBps(DUR_LONG)).to.equal(BPS_LONG);
    await expect(sl.connect(outsider).setTier(DUR_SHORT, 5_000n)).to.be.revertedWithCustomError(
      sl,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("setTier with zero duration reverts", async () => {
    const { sl } = await loadFixture(deployFixture);
    await expect(sl.setTier(0, BPS_SHORT)).to.be.revertedWithCustomError(sl, "BadTier");
  });

  it("lock mints credits = amount * multiplier and pulls principal", async () => {
    const { sl, token, alice } = await loadFixture(deployFixture);
    await expect(sl.connect(alice).lock(1000n, DUR_LONG))
      .to.emit(sl, "Locked");
    // base credits = 1000 * 2.5 = 2500, full immediately after lock
    const c = await sl.creditsOf(alice.address);
    expect(c >= 2495n && c <= 2500n).to.equal(true);
    expect(await token.balanceOf(await sl.getAddress())).to.equal(1000n);
  });

  it("reverts locking zero, a disabled tier, or a second position", async () => {
    const { sl, alice } = await loadFixture(deployFixture);
    await expect(sl.connect(alice).lock(0n, DUR_SHORT)).to.be.revertedWithCustomError(sl, "ZeroAmount");
    await expect(sl.connect(alice).lock(100n, 9999)).to.be.revertedWithCustomError(sl, "BadTier");

    await sl.connect(alice).lock(100n, DUR_SHORT);
    await expect(sl.connect(alice).lock(100n, DUR_SHORT)).to.be.revertedWithCustomError(
      sl,
      "PositionExists"
    );
  });

  it("credits decay linearly to zero at unlock", async () => {
    const { sl, alice } = await loadFixture(deployFixture);
    await sl.connect(alice).lock(1000n, DUR_SHORT); // base = 1000

    await time.increase(DUR_SHORT / 2);
    const half = await sl.creditsOf(alice.address);
    expect(half >= 495n && half <= 505n).to.equal(true);

    await time.increase(DUR_SHORT / 2 + 10); // past end
    expect(await sl.creditsOf(alice.address)).to.equal(0n);
  });

  it("credits are zero at exact unlock boundary", async () => {
    const { sl, alice } = await loadFixture(deployFixture);
    await sl.connect(alice).lock(1000n, DUR_SHORT);
    const end = (await sl.positions(alice.address)).end;
    await time.increaseTo(end);
    expect(await sl.creditsOf(alice.address)).to.equal(0n);
  });

  it("creditsOf is zero for an account with no position", async () => {
    const { sl, outsider } = await loadFixture(deployFixture);
    expect(await sl.creditsOf(outsider.address)).to.equal(0n);
  });

  it("withdraw only after unlock, returns principal, clears position", async () => {
    const { sl, token, alice } = await loadFixture(deployFixture);
    await sl.connect(alice).lock(1000n, DUR_SHORT);

    await expect(sl.connect(alice).withdraw()).to.be.revertedWithCustomError(sl, "StillLocked");

    await time.increase(DUR_SHORT + 1);
    const before = await token.balanceOf(alice.address);
    await expect(sl.connect(alice).withdraw())
      .to.emit(sl, "Withdrawn")
      .withArgs(alice.address, 1000n);

    expect(await token.balanceOf(alice.address)).to.equal(before + 1000n);
    expect((await sl.positions(alice.address)).amount).to.equal(0n);
    expect(await sl.creditsOf(alice.address)).to.equal(0n);
  });

  it("double-withdraw reverts (position cleared)", async () => {
    const { sl, alice } = await loadFixture(deployFixture);
    await sl.connect(alice).lock(1000n, DUR_SHORT);
    await time.increase(DUR_SHORT + 1);
    await sl.connect(alice).withdraw();
    await expect(sl.connect(alice).withdraw()).to.be.revertedWithCustomError(sl, "NoPosition");
  });

  it("withdraw with no position reverts", async () => {
    const { sl, outsider } = await loadFixture(deployFixture);
    await expect(sl.connect(outsider).withdraw()).to.be.revertedWithCustomError(sl, "NoPosition");
  });

  it("re-lock after withdraw works (single-position invariant resets)", async () => {
    const { sl, alice } = await loadFixture(deployFixture);
    await sl.connect(alice).lock(500n, DUR_SHORT);
    await time.increase(DUR_SHORT + 1);
    await sl.connect(alice).withdraw();
    await expect(sl.connect(alice).lock(700n, DUR_LONG)).to.emit(sl, "Locked");
  });
});
