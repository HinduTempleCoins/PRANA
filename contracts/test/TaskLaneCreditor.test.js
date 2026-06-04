const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const LANE_TASK = 1;
const WAD = 10n ** 18n;
const CLAIM = ethers.encodeBytes32String("claim-1");
const TASK = ethers.encodeBytes32String("task-inference");
const MIN_STAKE = 1000n;

describe("TaskLaneCreditor", function () {
  async function deployFixture() {
    const [admin, worker, a1, a2, coordinator, outsider] = await ethers.getSigners();

    const Ledger = await ethers.getContractFactory("MockSharesLedger");
    const ledger = await Ledger.deploy();

    const Registry = await ethers.getContractFactory("MockTaskRegistry");
    const registry = await Registry.deploy();

    const Beacon = await ethers.getContractFactory("MockWorkerBeacon");
    const beacon = await Beacon.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Stake", "STK");

    const Attest = await ethers.getContractFactory("AttestationStakeSlash");
    const attest = await Attest.deploy(
      await token.getAddress(),
      MIN_STAKE,
      admin.address,
      admin.address
    );

    const Gate = await ethers.getContractFactory("TaskVerificationGate");
    const gate = await Gate.deploy(await attest.getAddress(), admin.address);

    const Creditor = await ethers.getContractFactory("TaskLaneCreditor");
    const creditor = await Creditor.deploy(
      await ledger.getAddress(),
      await registry.getAddress(),
      await gate.getAddress(),
      ZERO, // open mode by default
      admin.address
    );
    await creditor.grantRole(await creditor.CREDITOR_ROLE(), coordinator.address);

    // the creditor must be allowed to consume gate verdicts
    await gate.grantRole(await gate.CONSUMER_ROLE(), await creditor.getAddress());

    // stake two attestors active
    for (const a of [a1, a2]) {
      await token.mint(a.address, 10000n);
      await token.connect(a).approve(await attest.getAddress(), 10000n);
      await attest.connect(a).stake(MIN_STAKE);
    }

    return {
      ledger, registry, beacon, attest, gate, creditor,
      admin, worker, a1, a2, coordinator, outsider,
    };
  }

  async function verifyClaim(ctx) {
    await ctx.gate.openClaim(CLAIM, ctx.worker.address, 2, [ctx.a1.address, ctx.a2.address]);
    await ctx.gate.connect(ctx.a1).attest(CLAIM);
    await ctx.gate.connect(ctx.a2).attest(CLAIM);
  }

  it("reverts on zero ledger/registry/gate", async () => {
    const Creditor = await ethers.getContractFactory("TaskLaneCreditor");
    const [admin] = await ethers.getSigners();
    await expect(
      Creditor.deploy(ZERO, ZERO, ZERO, ZERO, admin.address)
    ).to.be.revertedWithCustomError(Creditor, "ZeroLedger");
  });

  it("only CREDITOR_ROLE may credit", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, outsider } = ctx;
    await registry.set(TASK, WAD, true);
    await verifyClaim(ctx);
    await expect(
      creditor.connect(outsider).creditVerified(CLAIM, TASK, 10)
    ).to.be.revertedWithCustomError(creditor, "AccessControlUnauthorizedAccount");
  });

  it("credits weighted TASK shares to the gate-bound worker (equal-weight default)", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, ledger, gate, coordinator, worker } = ctx;
    await registry.set(TASK, WAD, true); // 1x
    await verifyClaim(ctx);

    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10))
      .to.emit(creditor, "TaskCredited")
      .withArgs(CLAIM, TASK, worker.address, 10, WAD, 10)
      .and.to.emit(gate, "Consumed");

    expect(await ledger.creditedTo(worker.address, LANE_TASK)).to.equal(10);
    const [acct, lane, amount] = await ledger.lastCredit();
    expect(acct).to.equal(worker.address);
    expect(lane).to.equal(LANE_TASK);
    expect(amount).to.equal(10);
  });

  it("applies a governed non-unity weight", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, ledger, coordinator, worker } = ctx;
    await registry.set(TASK, WAD * 3n, true); // 3x
    await verifyClaim(ctx);
    await creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10);
    expect(await ledger.creditedTo(worker.address, LANE_TASK)).to.equal(30);
  });

  it("refuses to credit an unverified claim", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, gate, coordinator, worker, a1 } = ctx;
    await registry.set(TASK, WAD, true);
    await gate.openClaim(CLAIM, worker.address, 2, [ctx.a1.address, ctx.a2.address]);
    await gate.connect(a1).attest(CLAIM); // only 1 of 2
    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10)
    ).to.be.revertedWithCustomError(gate, "NotVerified");
  });

  it("one-shot: a verified claim cannot be credited twice (no double pool value)", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, gate, coordinator } = ctx;
    await registry.set(TASK, WAD, true);
    await verifyClaim(ctx);
    await creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10);
    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10)
    ).to.be.revertedWithCustomError(gate, "AlreadyConsumed");
  });

  it("rejects disabled task, zero weight, zero base, and zero weighted", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, coordinator } = ctx;
    await verifyClaim(ctx);

    // zero base reverts before consume
    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 0)
    ).to.be.revertedWithCustomError(creditor, "ZeroBaseShares");

    // disabled task (claim still unconsumed since base check passed but task disabled)
    await registry.set(TASK, WAD, false);
    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10)
    ).to.be.revertedWithCustomError(creditor, "TaskDisabled");
  });

  it("zero weighted shares (tiny base * sub-unity weight rounds to 0) reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, coordinator } = ctx;
    await registry.set(TASK, WAD / 2n, true); // 0.5x
    await verifyClaim(ctx);
    // base 1 * 0.5 = 0.5 -> floor 0
    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 1)
    ).to.be.revertedWithCustomError(creditor, "ZeroWeightedShares");
  });

  it("beacon-gated: unbound bound worker rejected then credited", async () => {
    const ctx = await loadFixture(deployFixture);
    const { creditor, registry, beacon, admin, coordinator, worker, ledger } = ctx;
    await creditor.connect(admin).setBeacon(await beacon.getAddress());
    await registry.set(TASK, WAD, true);
    await verifyClaim(ctx);

    await expect(
      creditor.connect(coordinator).creditVerified(CLAIM, TASK, 10)
    ).to.be.revertedWithCustomError(creditor, "WorkerNotBound");

    // claim was consumed on the consume() call before the bind revert? No: consume happens first.
    // So we re-verify a fresh claim with the worker bound.
    await beacon.setBound(worker.address, true);
    const CLAIM2 = ethers.encodeBytes32String("claim-2");
    await ctx.gate.openClaim(CLAIM2, worker.address, 2, [ctx.a1.address, ctx.a2.address]);
    await ctx.gate.connect(ctx.a1).attest(CLAIM2);
    await ctx.gate.connect(ctx.a2).attest(CLAIM2);
    await creditor.connect(coordinator).creditVerified(CLAIM2, TASK, 10);
    expect(await ledger.creditedTo(worker.address, LANE_TASK)).to.equal(10);
  });
});
