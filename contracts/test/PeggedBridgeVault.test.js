const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E18 = 10n ** 18n;
const UNPAUSE_DELAY = 3600;

// Mode enum mirror (UNSET, LOCK_RELEASE, BURN_MINT)
const Mode = { UNSET: 0, LOCK_RELEASE: 1, BURN_MINT: 2 };
const REF = ethers.encodeBytes32String("dest");
const SRC = ethers.encodeBytes32String("src");

describe("PeggedBridgeVault (stage-2 single-custodian stub)", function () {
  async function deployFixture() {
    const [admin, custodian, user, recipient, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const lockTok = await Mock.deploy("Lockable", "LOCK"); // used in LOCK_RELEASE
    const mintTok = await Mock.deploy("Mintable", "MINT"); // used in BURN_MINT

    const Vault = await ethers.getContractFactory("PeggedBridgeVault");
    const vault = await Vault.deploy(UNPAUSE_DELAY, admin.address, custodian.address);
    const vaultAddr = await vault.getAddress();

    // configure modes
    await vault.connect(admin).setMode(await lockTok.getAddress(), Mode.LOCK_RELEASE);
    await vault.connect(admin).setMode(await mintTok.getAddress(), Mode.BURN_MINT);

    // fund user; approve vault
    await lockTok.mint(user.address, 1_000_000n * E18);
    await mintTok.mint(user.address, 1_000_000n * E18);
    await lockTok.connect(user).approve(vaultAddr, ethers.MaxUint256);
    await mintTok.connect(user).approve(vaultAddr, ethers.MaxUint256);

    return { vault, vaultAddr, lockTok, mintTok, admin, custodian, user, recipient, outsider };
  }

  it("deploys with custodian + guardian roles and configured modes", async () => {
    const { vault, admin, custodian, lockTok, mintTok } = await loadFixture(deployFixture);
    expect(await vault.hasRole(await vault.CUSTODIAN_ROLE(), custodian.address)).to.equal(true);
    expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), admin.address)).to.equal(true);
    expect(await vault.modeOf(await lockTok.getAddress())).to.equal(Mode.LOCK_RELEASE);
    expect(await vault.modeOf(await mintTok.getAddress())).to.equal(Mode.BURN_MINT);
  });

  it("mode is immutable once set; only admin sets it", async () => {
    const { vault, admin, outsider, lockTok } = await loadFixture(deployFixture);
    await expect(
      vault.connect(admin).setMode(await lockTok.getAddress(), Mode.BURN_MINT)
    ).to.be.revertedWithCustomError(vault, "ModeAlreadySet");

    const Mock = await ethers.getContractFactory("MockERC20");
    const fresh = await Mock.deploy("F", "F");
    await expect(
      vault.connect(outsider).setMode(await fresh.getAddress(), Mode.LOCK_RELEASE)
    ).to.be.reverted;
    await expect(
      vault.connect(admin).setMode(await fresh.getAddress(), Mode.UNSET)
    ).to.be.revertedWithCustomError(vault, "WrongMode");
  });

  describe("LOCK_RELEASE lifecycle", function () {
    it("locks (escrows + emits nonce) and releases", async () => {
      const { vault, vaultAddr, lockTok, user, recipient } = await loadFixture(deployFixture);
      const amt = 1_000n * E18;
      const addr = await lockTok.getAddress();

      await expect(vault.connect(user).lockForBridge(addr, amt, REF))
        .to.emit(vault, "BridgeLocked")
        .withArgs(0n, addr, user.address, amt, REF);
      expect(await lockTok.balanceOf(vaultAddr)).to.equal(amt);
      expect(await vault.outboundNonce()).to.equal(1n);

      // custodian releases to recipient on inbound nonce 42
      await expect(
        vault.connect(await getCustodian(vault)).releaseFromBridge(addr, recipient.address, amt, SRC, 42)
      ).to.emit(vault, "BridgeReleased").withArgs(42n, addr, recipient.address, amt, SRC);
      expect(await lockTok.balanceOf(recipient.address)).to.equal(amt);
    });

    it("rejects lock with zero amount or wrong mode", async () => {
      const { vault, lockTok, mintTok, user } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user).lockForBridge(await lockTok.getAddress(), 0, REF)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
      // mintTok is BURN_MINT — lock should reject
      await expect(
        vault.connect(user).lockForBridge(await mintTok.getAddress(), 1n, REF)
      ).to.be.revertedWithCustomError(vault, "WrongMode");
    });

    it("reverts inbound nonce replay", async () => {
      const { vault, custodian, lockTok, recipient } = await loadFixture(deployFixture);
      const addr = await lockTok.getAddress();
      // seed escrow so releases have funds
      await seedEscrow(vault, lockTok);
      await vault.connect(custodian).releaseFromBridge(addr, recipient.address, 100n * E18, SRC, 7);
      await expect(
        vault.connect(custodian).releaseFromBridge(addr, recipient.address, 100n * E18, SRC, 7)
      ).to.be.revertedWithCustomError(vault, "NonceAlreadyUsed");
    });

    it("non-custodian cannot release", async () => {
      const { vault, outsider, lockTok, recipient } = await loadFixture(deployFixture);
      await seedEscrow(vault, lockTok);
      await expect(
        vault.connect(outsider).releaseFromBridge(await lockTok.getAddress(), recipient.address, 1n, SRC, 1)
      ).to.be.reverted;
    });
  });

  describe("BURN_MINT lifecycle", function () {
    it("burns on outbound (supply drops) and mints on inbound", async () => {
      const { vault, mintTok, user, recipient, custodian } = await loadFixture(deployFixture);
      const addr = await mintTok.getAddress();
      const amt = 500n * E18;
      const supplyBefore = await mintTok.totalSupply();

      await expect(vault.connect(user).burnForBridge(addr, amt, REF))
        .to.emit(vault, "BridgeBurned").withArgs(0n, addr, user.address, amt, REF);
      expect(await mintTok.totalSupply()).to.equal(supplyBefore - amt);
      expect(await mintTok.balanceOf(await vault.getAddress())).to.equal(0n);

      await expect(
        vault.connect(custodian).mintFromBridge(addr, recipient.address, amt, SRC, 99)
      ).to.emit(vault, "BridgeMinted").withArgs(99n, addr, recipient.address, amt, SRC);
      expect(await mintTok.balanceOf(recipient.address)).to.equal(amt);
    });

    it("burnForBridge rejects a LOCK_RELEASE token", async () => {
      const { vault, lockTok, user } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user).burnForBridge(await lockTok.getAddress(), 1n, REF)
      ).to.be.revertedWithCustomError(vault, "WrongMode");
    });

    it("mintFromBridge rejects a LOCK_RELEASE token", async () => {
      const { vault, lockTok, custodian, recipient } = await loadFixture(deployFixture);
      await expect(
        vault.connect(custodian).mintFromBridge(await lockTok.getAddress(), recipient.address, 1n, SRC, 1)
      ).to.be.revertedWithCustomError(vault, "WrongMode");
    });
  });

  describe("daily release cap", function () {
    it("enforces the per-token cap and rolls over after 24h", async () => {
      const { vault, admin, custodian, lockTok, recipient } = await loadFixture(deployFixture);
      const addr = await lockTok.getAddress();
      await vault.connect(admin).setDailyCap(addr, 1_000n * E18);
      await seedEscrow(vault, lockTok, 10_000n * E18);

      // first release within cap
      await vault.connect(custodian).releaseFromBridge(addr, recipient.address, 600n * E18, SRC, 1);
      // second would exceed cap (600 + 600 > 1000)
      await expect(
        vault.connect(custodian).releaseFromBridge(addr, recipient.address, 600n * E18, SRC, 2)
      ).to.be.revertedWithCustomError(vault, "DailyCapExceeded");

      // after 24h the window resets
      await time.increase(24 * 3600 + 1);
      await expect(
        vault.connect(custodian).releaseFromBridge(addr, recipient.address, 600n * E18, SRC, 3)
      ).to.not.be.reverted;
    });

    it("cap of 0 means unlimited", async () => {
      const { vault, custodian, lockTok, recipient } = await loadFixture(deployFixture);
      const addr = await lockTok.getAddress();
      await seedEscrow(vault, lockTok, 10_000n * E18);
      await expect(
        vault.connect(custodian).releaseFromBridge(addr, recipient.address, 5_000n * E18, SRC, 1)
      ).to.not.be.reverted;
    });
  });

  describe("pause", function () {
    it("pause blocks lock/burn/release/mint", async () => {
      const { vault, admin, custodian, lockTok, mintTok, user, recipient } = await loadFixture(deployFixture);
      await seedEscrow(vault, lockTok);
      await vault.connect(admin).pause();

      await expect(
        vault.connect(user).lockForBridge(await lockTok.getAddress(), 1n, REF)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(
        vault.connect(user).burnForBridge(await mintTok.getAddress(), 1n, REF)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(
        vault.connect(custodian).releaseFromBridge(await lockTok.getAddress(), recipient.address, 1n, SRC, 1)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(
        vault.connect(custodian).mintFromBridge(await mintTok.getAddress(), recipient.address, 1n, SRC, 2)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("non-guardian cannot pause", async () => {
      const { vault, outsider } = await loadFixture(deployFixture);
      await expect(vault.connect(outsider).pause()).to.be.reverted;
    });
  });

  // --- helpers -----------------------------------------------------------
  async function getCustodian(vault) {
    const signers = await ethers.getSigners();
    return signers[1]; // custodian index in deployFixture
  }

  async function seedEscrow(vault, lockTok, amount = 1_000n * E18) {
    // lock some tokens so release has balance to pay out
    const signers = await ethers.getSigners();
    const user = signers[2]; // user index in deployFixture (already funded + approved)
    await vault.connect(user).lockForBridge(await lockTok.getAddress(), amount, REF);
  }
});
