const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// PR1 wiring — the permissionless-coordinator bond is ENFORCED in the TASK credit path.
//
// Proves the increment-1 contract change to TaskLaneCreditor:
//   * open mode (no registry wired) behaves exactly as before (CREDITOR_ROLE-only) — backward compat;
//   * once setCoordinatorRegistry() is wired, a creditVerified() caller that is NOT a bonded, active
//     coordinator reverts NotActiveCoordinator;
//   * a bonded, active coordinator credits normally;
//   * a slashed coordinator can no longer credit.

const TASK = 1; // Lane.TASK
const ONE = 10n ** 18n;
const MIN_STAKE = 100n * ONE;
const MIN_BOND = 1000n * ONE;
const TASK_ID = ethers.id("hathor-inference");

describe("TaskLaneCreditor — CoordinatorRegistry bond enforcement (PR1)", function () {
  async function deploy() {
    const [admin, worker, coord, att1, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");
    const stakeTok = await Mock.deploy("Stake", "STK");

    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    const cfg = await Cfg.deploy(admin.address, ONE, 1n, 1_000_000n);

    const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
    const ledger = await Ledger.deploy(await prana.getAddress(), await cfg.getAddress(), admin.address, 3600n, 1n, 1000n * ONE);

    const Att = await ethers.getContractFactory("AttestationStakeSlash");
    const attestation = await Att.deploy(await stakeTok.getAddress(), MIN_STAKE, admin.address, admin.address);

    const Gate = await ethers.getContractFactory("TaskVerificationGate");
    const gate = await Gate.deploy(await attestation.getAddress(), admin.address);

    const Reg = await ethers.getContractFactory("TaskRegistry");
    const registry = await Reg.deploy(admin.address);
    await registry.setTaskType(TASK_ID, ethers.ZeroHash, await gate.getAddress(), ONE, 0n, true);

    const Task = await ethers.getContractFactory("TaskLaneCreditor");
    const taskCreditor = await Task.deploy(
      await ledger.getAddress(),
      await registry.getAddress(),
      await gate.getAddress(),
      ethers.ZeroAddress,
      admin.address
    );

    const CoordReg = await ethers.getContractFactory("CoordinatorRegistry");
    const coordRegistry = await CoordReg.deploy(await prana.getAddress(), admin.address, treasury.address, MIN_BOND, 7n * 24n * 3600n);

    // roles
    await ledger.grantRole(await ledger.TASK_CREDITOR(), await taskCreditor.getAddress());
    await ledger.grantRole(await ledger.FUNDER_ROLE(), admin.address);
    await gate.grantRole(await gate.CONSUMER_ROLE(), await taskCreditor.getAddress());
    await taskCreditor.grantRole(await taskCreditor.CREDITOR_ROLE(), coord.address);

    // fund issuance
    await prana.mint(admin.address, 1_000_000n * ONE);
    await prana.connect(admin).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(admin).fundEpoch(100_000n * ONE);

    // stake attestor so K=1 attest is "active"
    await stakeTok.mint(att1.address, MIN_STAKE);
    await stakeTok.connect(att1).approve(await attestation.getAddress(), MIN_STAKE);
    await attestation.connect(att1).stake(MIN_STAKE);

    return { admin, worker, coord, att1, treasury, prana, cfg, ledger, gate, registry, taskCreditor, coordRegistry };
  }

  // open a K=1 claim and attest it so creditVerified can consume the verdict.
  async function verify(ctx, claimId) {
    const { gate, admin, worker, att1 } = ctx;
    await gate.connect(admin).openClaim(claimId, worker.address, 1, [att1.address]);
    await gate.connect(att1).attest(claimId);
    expect(await gate.isVerified(claimId)).to.equal(true);
  }

  it("open mode (registry unset) credits with CREDITOR_ROLE alone (backward compatible)", async () => {
    const ctx = await loadFixture(deploy);
    const { taskCreditor, ledger, coord, worker } = ctx;
    const claimId = ethers.id("claim-open");
    await verify(ctx, claimId);
    await taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, 100n);
    const e = BigInt(await ledger.epochLength());
    const epoch = BigInt((await ethers.provider.getBlock("latest")).timestamp) / e;
    expect(await ledger.poolShares(epoch, worker.address)).to.equal(100n);
  });

  it("with registry wired, an UNBONDED coordinator reverts NotActiveCoordinator", async () => {
    const ctx = await loadFixture(deploy);
    const { taskCreditor, coordRegistry, coord } = ctx;
    await taskCreditor.setCoordinatorRegistry(await coordRegistry.getAddress());
    const claimId = ethers.id("claim-unbonded");
    await verify(ctx, claimId);
    await expect(
      taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, 100n)
    ).to.be.revertedWithCustomError(coordRegistry, "NotActiveCoordinator");
  });

  it("a BONDED, active coordinator credits; after a slash it can no longer credit", async () => {
    const ctx = await loadFixture(deploy);
    const { taskCreditor, coordRegistry, prana, coord, ledger, worker } = ctx;
    await taskCreditor.setCoordinatorRegistry(await coordRegistry.getAddress());

    // coordinator posts its slashable bond -> becomes active.
    await prana.mint(coord.address, MIN_BOND);
    await prana.connect(coord).approve(await coordRegistry.getAddress(), MIN_BOND);
    await coordRegistry.connect(coord).register(MIN_BOND, "http://coord.example");
    expect(await coordRegistry.isActiveCoordinator(coord.address)).to.equal(true);

    const claimId = ethers.id("claim-bonded");
    await verify(ctx, claimId);
    await taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, 100n);
    const e = BigInt(await ledger.epochLength());
    const epoch = BigInt((await ethers.provider.getBlock("latest")).timestamp) / e;
    expect(await ledger.poolShares(epoch, worker.address)).to.equal(100n);

    // slash the coordinator -> terminally inactive -> next credit reverts.
    await coordRegistry.slash(coord.address, MIN_BOND);
    expect(await coordRegistry.isActiveCoordinator(coord.address)).to.equal(false);
    const claimId2 = ethers.id("claim-post-slash");
    await verify(ctx, claimId2);
    await expect(
      taskCreditor.connect(coord).creditVerified(claimId2, TASK_ID, 100n)
    ).to.be.revertedWithCustomError(coordRegistry, "NotActiveCoordinator");
  });
});
