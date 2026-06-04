const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const LANE_HASH = 0;
const B1 = ethers.encodeBytes32String("batch-1");
const B2 = ethers.encodeBytes32String("batch-2");

describe("HashLaneCreditor", function () {
  async function deployFixture() {
    const [admin, coordinator, w1, w2, outsider] = await ethers.getSigners();

    const Ledger = await ethers.getContractFactory("MockSharesLedger");
    const ledger = await Ledger.deploy();

    const Beacon = await ethers.getContractFactory("MockWorkerBeacon");
    const beacon = await Beacon.deploy();

    // open mode: beacon = zero
    const Creditor = await ethers.getContractFactory("HashLaneCreditor");
    const open = await Creditor.deploy(await ledger.getAddress(), ZERO, admin.address);
    await open.grantRole(await open.CREDITOR_ROLE(), coordinator.address);

    // gated mode: beacon wired
    const gated = await Creditor.deploy(
      await ledger.getAddress(),
      await beacon.getAddress(),
      admin.address
    );
    await gated.grantRole(await gated.CREDITOR_ROLE(), coordinator.address);

    return { ledger, beacon, open, gated, admin, coordinator, w1, w2, outsider };
  }

  it("reverts on zero ledger", async () => {
    const Creditor = await ethers.getContractFactory("HashLaneCreditor");
    const [admin] = await ethers.getSigners();
    await expect(Creditor.deploy(ZERO, ZERO, admin.address)).to.be.revertedWithCustomError(
      Creditor,
      "ZeroLedger"
    );
  });

  it("only CREDITOR_ROLE can submit", async () => {
    const { open, outsider, w1 } = await loadFixture(deployFixture);
    await expect(
      open.connect(outsider).submitBatch(1, B1, [w1.address], [10])
    ).to.be.revertedWithCustomError(open, "AccessControlUnauthorizedAccount");
  });

  it("credits each worker into the HASH lane and emits", async () => {
    const { open, ledger, coordinator, w1, w2 } = await loadFixture(deployFixture);

    await expect(open.connect(coordinator).submitBatch(7, B1, [w1.address, w2.address], [10, 25]))
      .to.emit(open, "BatchCredited")
      .withArgs(7, B1, 2, 35)
      .and.to.emit(open, "HashCredited")
      .withArgs(7, w1.address, 10)
      .and.to.emit(ledger, "SharesCredited");

    expect(await ledger.creditedTo(w1.address, LANE_HASH)).to.equal(10);
    expect(await ledger.creditedTo(w2.address, LANE_HASH)).to.equal(25);
    expect(await ledger.creditsLength()).to.equal(2);

    const [acct, lane, amount] = await ledger.lastCredit();
    expect(acct).to.equal(w2.address);
    expect(lane).to.equal(LANE_HASH);
    expect(amount).to.equal(25);
  });

  it("replay guard: same (epoch, batchId) cannot be submitted twice", async () => {
    const { open, coordinator, w1 } = await loadFixture(deployFixture);
    await open.connect(coordinator).submitBatch(3, B1, [w1.address], [10]);
    await expect(
      open.connect(coordinator).submitBatch(3, B1, [w1.address], [10])
    ).to.be.revertedWithCustomError(open, "BatchAlreadySubmitted");
  });

  it("same batchId in a different epoch is allowed", async () => {
    const { open, coordinator, w1 } = await loadFixture(deployFixture);
    await open.connect(coordinator).submitBatch(3, B1, [w1.address], [10]);
    await expect(open.connect(coordinator).submitBatch(4, B1, [w1.address], [10])).to.not.be
      .reverted;
  });

  it("rejects length mismatch / empty / zero worker / zero shares", async () => {
    const { open, coordinator, w1 } = await loadFixture(deployFixture);
    await expect(
      open.connect(coordinator).submitBatch(1, B1, [w1.address], [10, 20])
    ).to.be.revertedWithCustomError(open, "LengthMismatch");
    await expect(
      open.connect(coordinator).submitBatch(1, B2, [], [])
    ).to.be.revertedWithCustomError(open, "EmptyBatch");
    await expect(
      open.connect(coordinator).submitBatch(1, B2, [ZERO], [10])
    ).to.be.revertedWithCustomError(open, "ZeroWorker");
    await expect(
      open.connect(coordinator).submitBatch(1, B2, [w1.address], [0])
    ).to.be.revertedWithCustomError(open, "ZeroShares");
  });

  it("beacon-gated: unbound worker reverts, bound worker credits", async () => {
    const { gated, beacon, ledger, coordinator, w1 } = await loadFixture(deployFixture);
    await expect(
      gated.connect(coordinator).submitBatch(1, B1, [w1.address], [10])
    ).to.be.revertedWithCustomError(gated, "WorkerNotBound");

    await beacon.setBound(w1.address, true);
    await gated.connect(coordinator).submitBatch(1, B1, [w1.address], [10]);
    expect(await ledger.creditedTo(w1.address, LANE_HASH)).to.equal(10);
  });

  it("setBeacon can switch between open and gated mode", async () => {
    const { open, beacon, admin, coordinator, w1 } = await loadFixture(deployFixture);
    await open.connect(admin).setBeacon(await beacon.getAddress());
    await expect(
      open.connect(coordinator).submitBatch(1, B1, [w1.address], [10])
    ).to.be.revertedWithCustomError(open, "WorkerNotBound");

    await open.connect(admin).setBeacon(ZERO);
    await expect(open.connect(coordinator).submitBatch(1, B1, [w1.address], [10])).to.not.be
      .reverted;
  });
});
