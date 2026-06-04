const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// DAOTimelock = a self-wiring TimelockController wrapper:
//   proposers/cancellers = [governor], executors = [address(0)] (open), no standing admin.
// These tests drive the timelock directly (the `governor` here is just an EOA standing in for the
// Governor contract) to prove the role wiring and the delay enforcement.
describe("DAOTimelock", function () {
  const MIN_DELAY = 3600; // seconds

  async function deployFixture() {
    const [deployer, governor, executor, stranger, target] = await ethers.getSigners();

    const Timelock = await ethers.getContractFactory("DAOTimelock");
    const timelock = await Timelock.deploy(MIN_DELAY, governor.address);
    await timelock.waitForDeployment();

    return { deployer, governor, executor, stranger, target, timelock };
  }

  // A trivial operation: call `getMinDelay()` on the timelock itself (no value, harmless),
  // used only to exercise schedule/execute. We use an empty-payload self-call.
  function buildOp(timelockAddr) {
    const targetAddr = timelockAddr;
    const value = 0n;
    const data = "0x"; // empty calldata; a plain call with no function selector
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id("dao-timelock-test-op");
    return { targetAddr, value, data, predecessor, salt };
  }

  it("wires roles: governor is proposer, execution is open, no standing admin", async function () {
    const { deployer, governor, stranger, timelock } = await deployFixture();

    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();

    expect(await timelock.hasRole(PROPOSER_ROLE, governor.address)).to.equal(true);
    expect(await timelock.hasRole(CANCELLER_ROLE, governor.address)).to.equal(true);
    expect(await timelock.isProposer(governor.address)).to.equal(true);
    expect(await timelock.isProposer(stranger.address)).to.equal(false);

    // Open execution: the address(0) executor is granted.
    expect(await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress)).to.equal(true);
    expect(await timelock.isExecutionOpen()).to.equal(true);

    // No standing admin: neither the deployer nor the governor holds DEFAULT_ADMIN_ROLE.
    // The only holder is the timelock itself (self-administration).
    expect(await timelock.hasRole(ADMIN_ROLE, deployer.address)).to.equal(false);
    expect(await timelock.hasRole(ADMIN_ROLE, governor.address)).to.equal(false);
    expect(await timelock.hasRole(ADMIN_ROLE, await timelock.getAddress())).to.equal(true);

    expect(await timelock.governor()).to.equal(governor.address);
    expect(await timelock.getMinDelay()).to.equal(MIN_DELAY);
  });

  it("reverts construction with a zero governor", async function () {
    const Timelock = await ethers.getContractFactory("DAOTimelock");
    await expect(Timelock.deploy(MIN_DELAY, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Timelock,
      "ZeroGovernor"
    );
  });

  it("governor can schedule; anyone can execute after the delay", async function () {
    const { governor, executor, timelock } = await deployFixture();
    const tlAddr = await timelock.getAddress();
    const { targetAddr, value, data, predecessor, salt } = buildOp(tlAddr);

    const id = await timelock.hashOperation(targetAddr, value, data, predecessor, salt);

    // Schedule as the governor.
    await timelock.connect(governor).schedule(targetAddr, value, data, predecessor, salt, MIN_DELAY);

    // isOperationReadyAt view: not ready before eta, ready after.
    const eta = await timelock.getTimestamp(id);
    expect(await timelock.isOperationReadyAt(id, Number(eta) - 1)).to.equal(false);
    expect(await timelock.isOperationReadyAt(id, eta)).to.equal(true);

    // Cannot execute before the delay elapses.
    await expect(
      timelock.connect(executor).execute(targetAddr, value, data, predecessor, salt)
    ).to.be.reverted; // TimelockUnexpectedOperationState

    // Advance past the delay; now ANY account (executor, a non-proposer) can execute.
    await time.increase(MIN_DELAY + 1);
    await timelock.connect(executor).execute(targetAddr, value, data, predecessor, salt);

    expect(await timelock.isOperationDone(id)).to.equal(true);
  });

  it("a non-proposer cannot schedule", async function () {
    const { stranger, timelock } = await deployFixture();
    const tlAddr = await timelock.getAddress();
    const { targetAddr, value, data, predecessor, salt } = buildOp(tlAddr);

    await expect(
      timelock.connect(stranger).schedule(targetAddr, value, data, predecessor, salt, MIN_DELAY)
    ).to.be.reverted; // AccessControlUnauthorizedAccount (missing PROPOSER_ROLE)
  });

  it("a non-canceller cannot cancel a scheduled operation", async function () {
    const { governor, stranger, timelock } = await deployFixture();
    const tlAddr = await timelock.getAddress();
    const { targetAddr, value, data, predecessor, salt } = buildOp(tlAddr);
    const id = await timelock.hashOperation(targetAddr, value, data, predecessor, salt);

    await timelock.connect(governor).schedule(targetAddr, value, data, predecessor, salt, MIN_DELAY);
    await expect(timelock.connect(stranger).cancel(id)).to.be.reverted;

    // The governor (canceller) can.
    await timelock.connect(governor).cancel(id);
    expect(await timelock.isOperation(id)).to.equal(false);
  });
});
