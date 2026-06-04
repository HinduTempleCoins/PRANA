const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const MIN_BOND = 1000n * ONE;
const COOLDOWN = 7n * 24n * 3600n;
const CLAIM_WINDOW = 3600n; // 1 hour to settle before others may release

const job = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("JobClaimLedger (PR2)", function () {
  async function deploy() {
    const [admin, treasury, coordA, coordB, worker, outsider] = await ethers.getSigners();

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

    // Register coordA and coordB as active, bonded coordinators (permissionless path a).
    for (const c of [coordA, coordB]) {
      await prana.mint(c.address, 1_000_000n * ONE);
      await prana.connect(c).approve(await reg.getAddress(), ethers.MaxUint256);
      await reg.connect(c).register(MIN_BOND, "");
    }

    const Ledger = await ethers.getContractFactory("JobClaimLedger");
    const ledger = await Ledger.deploy(await reg.getAddress(), admin.address, CLAIM_WINDOW);

    return { admin, treasury, coordA, coordB, worker, outsider, prana, reg, ledger };
  }

  describe("deployment", function () {
    it("wires registry + claim window", async () => {
      const { ledger, reg } = await loadFixture(deploy);
      expect(await ledger.registry()).to.equal(await reg.getAddress());
      expect(await ledger.claimWindow()).to.equal(CLAIM_WINDOW);
    });
  });

  describe("claim + dedup", function () {
    it("first authorized coordinator claims; views reflect it", async () => {
      const { ledger, coordA, worker } = await loadFixture(deploy);
      const id = job("spec#1");
      await expect(ledger.connect(coordA).claim(id, worker.address))
        .to.emit(ledger, "JobClaimed");
      expect(await ledger.isClaimed(id)).to.equal(true);
      expect(await ledger.isSettled(id)).to.equal(false);
      expect(await ledger.claimantOf(id)).to.equal(coordA.address);
      expect(await ledger.workerOf(id)).to.equal(worker.address);
    });

    it("a second claim of the same jobId reverts AlreadyClaimed (cross-coordinator dedup)", async () => {
      const { ledger, coordA, coordB, worker } = await loadFixture(deploy);
      const id = job("spec#dup");
      await ledger.connect(coordA).claim(id, worker.address);
      await expect(ledger.connect(coordB).claim(id, worker.address))
        .to.be.revertedWithCustomError(ledger, "AlreadyClaimed")
        .withArgs(id, coordA.address);
    });

    it("rejects zero jobId / zero worker", async () => {
      const { ledger, coordA, worker } = await loadFixture(deploy);
      await expect(ledger.connect(coordA).claim(ethers.ZeroHash, worker.address)).to.be.revertedWithCustomError(
        ledger,
        "ZeroJobId"
      );
      await expect(ledger.connect(coordA).claim(job("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ledger,
        "ZeroWorker"
      );
    });
  });

  describe("authorization gating", function () {
    it("an unregistered caller cannot claim", async () => {
      const { ledger, outsider, worker } = await loadFixture(deploy);
      await expect(ledger.connect(outsider).claim(job("y"), worker.address))
        .to.be.revertedWithCustomError(ledger, "NotAuthorizedCoordinator")
        .withArgs(outsider.address);
    });

    it("a deregistered (inactive) coordinator cannot claim", async () => {
      const { ledger, reg, coordA, worker } = await loadFixture(deploy);
      await reg.connect(coordA).requestDeregister(); // immediately inactive
      await expect(ledger.connect(coordA).claim(job("z"), worker.address)).to.be.revertedWithCustomError(
        ledger,
        "NotAuthorizedCoordinator"
      );
    });

    it("AUTHORIZED_COORDINATOR role works even with no registry wired", async () => {
      const { admin, outsider, worker } = await loadFixture(deploy);
      const Ledger = await ethers.getContractFactory("JobClaimLedger");
      const ledger = await Ledger.deploy(ethers.ZeroAddress, admin.address, CLAIM_WINDOW);
      // No registry -> only role path. outsider blocked until granted.
      await expect(ledger.connect(outsider).claim(job("r"), worker.address)).to.be.revertedWithCustomError(
        ledger,
        "NotAuthorizedCoordinator"
      );
      await ledger.connect(admin).grantRole(await ledger.AUTHORIZED_COORDINATOR(), outsider.address);
      await expect(ledger.connect(outsider).claim(job("r"), worker.address)).to.emit(ledger, "JobClaimed");
    });
  });

  describe("settle", function () {
    it("claimant settles -> permanent; cannot release or re-claim", async () => {
      const { ledger, coordA, coordB, worker } = await loadFixture(deploy);
      const id = job("settle#1");
      await ledger.connect(coordA).claim(id, worker.address);
      await expect(ledger.connect(coordA).settle(id)).to.emit(ledger, "JobSettled").withArgs(id, coordA.address);

      expect(await ledger.isSettled(id)).to.equal(true);
      expect(await ledger.isClaimed(id)).to.equal(true);
      // Re-claim of a settled id reverts.
      await expect(ledger.connect(coordB).claim(id, worker.address)).to.be.revertedWithCustomError(
        ledger,
        "AlreadySettled"
      );
      // Release of a settled id reverts.
      await expect(ledger.connect(coordA).release(id)).to.be.revertedWithCustomError(ledger, "AlreadySettled");
      // Double settle reverts.
      await expect(ledger.connect(coordA).settle(id)).to.be.revertedWithCustomError(ledger, "AlreadySettled");
    });

    it("only the claimant may settle", async () => {
      const { ledger, coordA, coordB, worker } = await loadFixture(deploy);
      const id = job("settle#2");
      await ledger.connect(coordA).claim(id, worker.address);
      await expect(ledger.connect(coordB).settle(id))
        .to.be.revertedWithCustomError(ledger, "NotClaimant")
        .withArgs(id, coordB.address);
    });

    it("settling an unclaimed job reverts", async () => {
      const { ledger, coordA } = await loadFixture(deploy);
      await expect(ledger.connect(coordA).settle(job("nope"))).to.be.revertedWithCustomError(
        ledger,
        "NotClaimed"
      );
    });
  });

  describe("release / expiry", function () {
    it("claimant can release early; job becomes claimable again", async () => {
      const { ledger, coordA, coordB, worker } = await loadFixture(deploy);
      const id = job("rel#1");
      await ledger.connect(coordA).claim(id, worker.address);
      await expect(ledger.connect(coordA).release(id))
        .to.emit(ledger, "JobReleased")
        .withArgs(id, coordA.address, coordA.address);

      expect(await ledger.isClaimed(id)).to.equal(false);
      expect(await ledger.claimantOf(id)).to.equal(ethers.ZeroAddress);
      // Now coordB can claim it.
      await expect(ledger.connect(coordB).claim(id, worker.address)).to.emit(ledger, "JobClaimed");
      expect(await ledger.claimantOf(id)).to.equal(coordB.address);
    });

    it("another coordinator must wait out the window to release a dropped claim", async () => {
      const { ledger, coordA, coordB, worker } = await loadFixture(deploy);
      const id = job("rel#2");
      await ledger.connect(coordA).claim(id, worker.address);

      // coordB cannot release before the window elapses.
      await expect(ledger.connect(coordB).release(id)).to.be.revertedWithCustomError(
        ledger,
        "ClaimWindowNotElapsed"
      );

      await time.increase(CLAIM_WINDOW + 1n);
      await expect(ledger.connect(coordB).release(id))
        .to.emit(ledger, "JobReleased")
        .withArgs(id, coordB.address, coordA.address);
      expect(await ledger.isClaimed(id)).to.equal(false);
    });

    it("releasableAt view reflects claim + window", async () => {
      const { ledger, coordA, worker } = await loadFixture(deploy);
      const id = job("rel#3");
      expect(await ledger.releasableAt(id)).to.equal(0n);
      const tx = await ledger.connect(coordA).claim(id, worker.address);
      const blk = await ethers.provider.getBlock(tx.blockNumber);
      expect(await ledger.releasableAt(id)).to.equal(BigInt(blk.timestamp) + CLAIM_WINDOW);
    });

    it("releasing an unclaimed job reverts", async () => {
      const { ledger, coordA } = await loadFixture(deploy);
      await expect(ledger.connect(coordA).release(job("ghost"))).to.be.revertedWithCustomError(
        ledger,
        "NotClaimed"
      );
    });
  });

  describe("governed setters", function () {
    it("setRegistry / setClaimWindow gated to CONFIG_ROLE", async () => {
      const { ledger, admin, outsider } = await loadFixture(deploy);
      await expect(ledger.connect(admin).setClaimWindow(99n))
        .to.emit(ledger, "ClaimWindowSet")
        .withArgs(99n);
      await expect(ledger.connect(admin).setRegistry(ethers.ZeroAddress))
        .to.emit(ledger, "RegistrySet")
        .withArgs(ethers.ZeroAddress);
      await expect(ledger.connect(outsider).setClaimWindow(1n)).to.be.reverted;
    });

    it("clearing the registry falls back to role-only authorization", async () => {
      const { ledger, admin, coordA, worker } = await loadFixture(deploy);
      // coordA is registry-active but holds no role; clearing registry blocks it.
      await ledger.connect(admin).setRegistry(ethers.ZeroAddress);
      await expect(ledger.connect(coordA).claim(job("fb"), worker.address)).to.be.revertedWithCustomError(
        ledger,
        "NotAuthorizedCoordinator"
      );
      await ledger.connect(admin).grantRole(await ledger.AUTHORIZED_COORDINATOR(), coordA.address);
      await expect(ledger.connect(coordA).claim(job("fb"), worker.address)).to.emit(ledger, "JobClaimed");
    });
  });
});
