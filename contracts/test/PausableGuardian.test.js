const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("PausableGuardian (via DemoPausableVault)", function () {
  const DELAY = 3600; // 1h timelock on unpause

  async function deployFixture() {
    const [guardian, outsider] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("DemoPausableVault");
    const vault = await Vault.deploy(DELAY, guardian.address);
    return { vault, guardian, outsider };
  }

  it("deploys unpaused with the configured delay and roles", async () => {
    const { vault, guardian } = await loadFixture(deployFixture);
    expect(await vault.paused()).to.equal(false);
    expect(await vault.unpauseDelay()).to.equal(DELAY);
    expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), guardian.address)).to.equal(true);
  });

  it("protected action works while unpaused", async () => {
    const { vault } = await loadFixture(deployFixture);
    await vault.bump();
    expect(await vault.value()).to.equal(1n);
  });

  it("guardian pauses immediately and blocks protected action", async () => {
    const { vault } = await loadFixture(deployFixture);
    await vault.pause();
    expect(await vault.paused()).to.equal(true);
    await expect(vault.bump()).to.be.revertedWithCustomError(vault, "EnforcedPause");
  });

  it("non-guardian cannot pause", async () => {
    const { vault, outsider } = await loadFixture(deployFixture);
    await expect(vault.connect(outsider).pause()).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("unpause requires a proposal and the timelock to elapse", async () => {
    const { vault } = await loadFixture(deployFixture);
    await vault.pause();

    // cannot execute without a proposal
    await expect(vault.executeUnpause()).to.be.revertedWithCustomError(vault, "UnpauseNotProposed");

    // propose
    const tx = await vault.proposeUnpause();
    const block = await ethers.provider.getBlock(tx.blockNumber);
    const readyAt = BigInt(block.timestamp) + BigInt(DELAY);
    expect(await vault.unpauseReadyAt()).to.equal(readyAt);

    // too early
    await expect(vault.executeUnpause()).to.be.revertedWithCustomError(vault, "UnpauseNotReady");

    // wait out the timelock then execute
    await time.increaseTo(readyAt);
    await vault.executeUnpause();
    expect(await vault.paused()).to.equal(false);
    expect(await vault.unpauseReadyAt()).to.equal(0n);

    // protected action restored
    await vault.bump();
    expect(await vault.value()).to.equal(1n);
  });

  it("proposeUnpause emits with the ready timestamp", async () => {
    const { vault, guardian } = await loadFixture(deployFixture);
    await vault.pause();
    await expect(vault.proposeUnpause()).to.emit(vault, "UnpauseProposed");
    expect(await vault.unpauseReadyAt()).to.be.greaterThan(0n);
  });

  it("cancelUnpause clears a pending proposal", async () => {
    const { vault, guardian } = await loadFixture(deployFixture);
    await vault.pause();
    await vault.proposeUnpause();
    await expect(vault.cancelUnpause()).to.emit(vault, "UnpauseCancelled").withArgs(guardian.address);
    expect(await vault.unpauseReadyAt()).to.equal(0n);
    // now execution must fail again until re-proposed
    await time.increase(DELAY + 1);
    await expect(vault.executeUnpause()).to.be.revertedWithCustomError(vault, "UnpauseNotProposed");
  });

  it("cancelUnpause with nothing pending reverts", async () => {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.cancelUnpause()).to.be.revertedWithCustomError(vault, "UnpauseNotProposed");
  });

  it("pausing again clears an in-flight unpause proposal", async () => {
    const { vault } = await loadFixture(deployFixture);
    await vault.pause();
    await vault.proposeUnpause();
    expect(await vault.unpauseReadyAt()).to.be.greaterThan(0n);
    await vault.pause(); // re-pause resets the proposal
    expect(await vault.unpauseReadyAt()).to.equal(0n);
  });

  it("proposeUnpause / executeUnpause require paused state", async () => {
    const { vault } = await loadFixture(deployFixture);
    await expect(vault.proposeUnpause()).to.be.revertedWithCustomError(vault, "ExpectedPause");
    await expect(vault.executeUnpause()).to.be.revertedWithCustomError(vault, "ExpectedPause");
  });

  it("non-guardian cannot propose, execute, or cancel", async () => {
    const { vault, outsider } = await loadFixture(deployFixture);
    await vault.pause();
    await expect(vault.connect(outsider).proposeUnpause()).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
    await expect(vault.connect(outsider).executeUnpause()).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
    await expect(vault.connect(outsider).cancelUnpause()).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });
});
