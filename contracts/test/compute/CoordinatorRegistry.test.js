const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const MIN_BOND = 1000n * ONE;
const COOLDOWN = 7n * 24n * 3600n; // 7 days

describe("CoordinatorRegistry (PR1)", function () {
  async function deploy() {
    const [admin, treasury, coordA, coordB, slasher, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

    const Reg = await ethers.getContractFactory("CoordinatorRegistry");
    const reg = await Reg.deploy(
      await prana.getAddress(),
      admin.address,
      treasury.address,
      MIN_BOND,
      COOLDOWN
    );

    // Fund coordinators with PRANA and approve the registry.
    for (const c of [coordA, coordB]) {
      await prana.mint(c.address, 1_000_000n * ONE);
      await prana.connect(c).approve(await reg.getAddress(), ethers.MaxUint256);
    }

    return { admin, treasury, coordA, coordB, slasher, outsider, prana, reg };
  }

  describe("deployment", function () {
    it("sets params and roles; rejects zero addresses", async () => {
      const { reg, admin, treasury, prana } = await loadFixture(deploy);
      expect(await reg.minBond()).to.equal(MIN_BOND);
      expect(await reg.cooldown()).to.equal(COOLDOWN);
      expect(await reg.treasury()).to.equal(treasury.address);
      expect(await reg.hasRole(await reg.SLASHER_ROLE(), admin.address)).to.equal(true);

      const Reg = await ethers.getContractFactory("CoordinatorRegistry");
      await expect(
        Reg.deploy(ethers.ZeroAddress, admin.address, treasury.address, MIN_BOND, COOLDOWN)
      ).to.be.revertedWithCustomError(Reg, "ZeroAddress");
      await expect(
        Reg.deploy(await prana.getAddress(), admin.address, ethers.ZeroAddress, MIN_BOND, COOLDOWN)
      ).to.be.revertedWithCustomError(Reg, "ZeroAddress");
    });
  });

  describe("register (happy path + guards)", function () {
    it("registers with a sufficient bond, pulls PRANA, marks active", async () => {
      const { reg, prana, coordA } = await loadFixture(deploy);
      await expect(reg.connect(coordA).register(MIN_BOND, "ipfs://poolA"))
        .to.emit(reg, "CoordinatorRegistered")
        .withArgs(coordA.address, MIN_BOND, "ipfs://poolA");

      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(true);
      expect(await reg.bondOf(coordA.address)).to.equal(MIN_BOND);
      expect(await prana.balanceOf(await reg.getAddress())).to.equal(MIN_BOND);

      const rec = await reg.coordinatorOf(coordA.address);
      expect(rec.registered).to.equal(true);
      expect(rec.active).to.equal(true);
      expect(rec.slashed).to.equal(false);
      expect(rec.metadataURI).to.equal("ipfs://poolA");
    });

    it("reverts below minimum bond", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await expect(reg.connect(coordA).register(MIN_BOND - 1n, ""))
        .to.be.revertedWithCustomError(reg, "BondBelowMinimum")
        .withArgs(MIN_BOND - 1n, MIN_BOND);
    });

    it("reverts double registration", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      await expect(reg.connect(coordA).register(MIN_BOND, "")).to.be.revertedWithCustomError(
        reg,
        "AlreadyRegistered"
      );
    });

    it("requireActiveCoordinator reverts for an unregistered address", async () => {
      const { reg, outsider } = await loadFixture(deploy);
      await expect(reg.requireActiveCoordinator(outsider.address))
        .to.be.revertedWithCustomError(reg, "NotActiveCoordinator")
        .withArgs(outsider.address);
    });
  });

  describe("bond top-up", function () {
    it("adds to bond and emits", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      await expect(reg.connect(coordA).topUpBond(500n * ONE))
        .to.emit(reg, "BondToppedUp")
        .withArgs(coordA.address, 500n * ONE, MIN_BOND + 500n * ONE);
      expect(await reg.bondOf(coordA.address)).to.equal(MIN_BOND + 500n * ONE);
    });

    it("re-activates an under-bonded coordinator after a minBond raise", async () => {
      const { reg, admin, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      // Raise minBond above current bond -> soft-gated inactive.
      await reg.connect(admin).setMinBond(MIN_BOND * 2n);
      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(false);
      // Top up to clear it.
      await reg.connect(coordA).topUpBond(MIN_BOND);
      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(true);
    });

    it("rejects top-up by unregistered / zero amount", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await expect(reg.connect(coordA).topUpBond(ONE)).to.be.revertedWithCustomError(reg, "NotRegistered");
      await reg.connect(coordA).register(MIN_BOND, "");
      await expect(reg.connect(coordA).topUpBond(0n)).to.be.revertedWithCustomError(reg, "ZeroAmount");
    });
  });

  describe("deregistration + cooldown withdraw", function () {
    it("requestDeregister deactivates immediately; withdraw only after cooldown", async () => {
      const { reg, prana, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");

      await expect(reg.connect(coordA).requestDeregister()).to.emit(reg, "DeregisterRequested");
      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(false);

      // Too early.
      await expect(reg.connect(coordA).withdrawBond()).to.be.revertedWithCustomError(
        reg,
        "CooldownNotElapsed"
      );

      // Advance past cooldown.
      await time.increase(COOLDOWN + 1n);
      const before = await prana.balanceOf(coordA.address);
      await expect(reg.connect(coordA).withdrawBond())
        .to.emit(reg, "Deregistered")
        .withArgs(coordA.address, MIN_BOND);
      const after = await prana.balanceOf(coordA.address);
      expect(after - before).to.equal(MIN_BOND);

      // Record cleared -> can register fresh again.
      expect(await reg.bondOf(coordA.address)).to.equal(0n);
      await reg.connect(coordA).register(MIN_BOND, "again");
      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(true);
    });

    it("cannot withdraw without requesting exit; cannot request twice", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      await expect(reg.connect(coordA).withdrawBond()).to.be.revertedWithCustomError(reg, "NotExiting");
      await reg.connect(coordA).requestDeregister();
      await expect(reg.connect(coordA).requestDeregister()).to.be.revertedWithCustomError(
        reg,
        "ExitAlreadyRequested"
      );
    });

    it("withdrawableAt view tracks the cooldown deadline", async () => {
      const { reg, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      expect(await reg.withdrawableAt(coordA.address)).to.equal(0n);
      const tx = await reg.connect(coordA).requestDeregister();
      const blk = await ethers.provider.getBlock(tx.blockNumber);
      expect(await reg.withdrawableAt(coordA.address)).to.equal(BigInt(blk.timestamp) + COOLDOWN);
    });
  });

  describe("slashing", function () {
    it("full slash routes bond to treasury, deactivates terminally", async () => {
      const { reg, prana, treasury, admin, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");

      const tBefore = await prana.balanceOf(treasury.address);
      await expect(reg.connect(admin).slash(coordA.address, MIN_BOND))
        .to.emit(reg, "CoordinatorSlashed")
        .withArgs(coordA.address, MIN_BOND, treasury.address);
      expect((await prana.balanceOf(treasury.address)) - tBefore).to.equal(MIN_BOND);

      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(false);
      const rec = await reg.coordinatorOf(coordA.address);
      expect(rec.slashed).to.equal(true);
      expect(rec.bond).to.equal(0n);
    });

    it("partial slash leaves coordinator terminally inactive and unable to withdraw", async () => {
      const { reg, treasury, prana, admin, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");
      await reg.connect(admin).slash(coordA.address, MIN_BOND / 2n);

      expect((await prana.balanceOf(treasury.address))).to.equal(MIN_BOND / 2n);
      expect(await reg.isActiveCoordinator(coordA.address)).to.equal(false);
      // Slashed -> cannot top up, cannot deregister, cannot withdraw.
      await expect(reg.connect(coordA).topUpBond(ONE)).to.be.revertedWithCustomError(reg, "AlreadySlashed");
      await expect(reg.connect(coordA).requestDeregister()).to.be.revertedWithCustomError(reg, "AlreadySlashed");
      await expect(reg.connect(coordA).withdrawBond()).to.be.revertedWithCustomError(reg, "AlreadySlashed");
    });

    it("only SLASHER_ROLE can slash; reverts on over-slash / double-slash / unregistered", async () => {
      const { reg, admin, slasher, outsider, coordA } = await loadFixture(deploy);
      await reg.connect(coordA).register(MIN_BOND, "");

      await expect(reg.connect(outsider).slash(coordA.address, ONE)).to.be.reverted;
      await expect(reg.connect(admin).slash(coordA.address, MIN_BOND + 1n))
        .to.be.revertedWithCustomError(reg, "SlashExceedsBond")
        .withArgs(MIN_BOND + 1n, MIN_BOND);
      await expect(reg.connect(admin).slash(outsider.address, ONE)).to.be.revertedWithCustomError(
        reg,
        "NotRegistered"
      );

      // Grant SLASHER to a fresh signer and confirm it works, then double-slash reverts.
      await reg.connect(admin).grantRole(await reg.SLASHER_ROLE(), slasher.address);
      await reg.connect(slasher).slash(coordA.address, MIN_BOND);
      await expect(reg.connect(admin).slash(coordA.address, 1n)).to.be.revertedWithCustomError(
        reg,
        "AlreadySlashed"
      );
    });
  });

  describe("governed setters", function () {
    it("setMinBond / setCooldown gated to SLASHER_ROLE", async () => {
      const { reg, admin, outsider } = await loadFixture(deploy);
      await expect(reg.connect(admin).setMinBond(5n * ONE)).to.emit(reg, "MinBondSet").withArgs(5n * ONE);
      await expect(reg.connect(admin).setCooldown(100n)).to.emit(reg, "CooldownSet").withArgs(100n);
      await expect(reg.connect(outsider).setMinBond(1n)).to.be.reverted;
    });

    it("setTreasury gated to admin, rejects zero", async () => {
      const { reg, admin, outsider } = await loadFixture(deploy);
      await expect(reg.connect(admin).setTreasury(outsider.address))
        .to.emit(reg, "TreasurySet")
        .withArgs(outsider.address);
      await expect(reg.connect(admin).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        reg,
        "ZeroAddress"
      );
      await expect(reg.connect(outsider).setTreasury(admin.address)).to.be.reverted;
    });
  });
});
