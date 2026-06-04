const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
// Kind enum: PREFERENCE_RANK=0, SFT=1, EVAL_REDTEAM=2, ANNOTATION=3, SURVEY=4, FOCUS_GROUP=5, EXPERT=6, CURATION=7
const PREFERENCE_RANK = 0;
const SFT = 1;

const TASK_ID = ethers.id("rlhf-preference-v1");
const SPEC = ethers.id("spec-blob");

describe("HumanTaskRegistry (AG1)", function () {
  async function deploy() {
    const [admin, gov, gate, outsider] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("HumanTaskRegistry");
    const reg = await Reg.deploy(admin.address);
    return { reg, admin, gov, gate, outsider };
  }

  it("reverts zero admin", async () => {
    const Reg = await ethers.getContractFactory("HumanTaskRegistry");
    await expect(Reg.deploy(ethers.ZeroAddress)).to.be.revertedWith("admin=0");
  });

  it("registers a human task-type and exposes views", async () => {
    const { reg, gate } = await loadFixture(deploy);
    await expect(
      reg.setTaskType(TASK_ID, SPEC, PREFERENCE_RANK, gate.address, 2n * ONE, 1n, true, true)
    )
      .to.emit(reg, "HumanTaskTypeSet")
      .withArgs(TASK_ID, SPEC, PREFERENCE_RANK, gate.address, 2n * ONE, 1n, true, true);

    const t = await reg.taskType(TASK_ID);
    expect(t.specHash).to.equal(SPEC);
    expect(t.kind).to.equal(PREFERENCE_RANK);
    expect(t.verificationGate).to.equal(gate.address);
    expect(t.shareWeight).to.equal(2n * ONE);
    expect(t.minReputation).to.equal(1n);
    expect(t.twoBuyer).to.equal(true);
    expect(t.enabled).to.equal(true);

    expect(await reg.isEnabled(TASK_ID)).to.equal(true);
    expect(await reg.shareWeight(TASK_ID)).to.equal(2n * ONE);
    expect(await reg.minReputation(TASK_ID)).to.equal(1n);
    expect(await reg.isTwoBuyer(TASK_ID)).to.equal(true);
    expect(await reg.isKnown(TASK_ID)).to.equal(true);
    expect(await reg.taskCount()).to.equal(1n);
    expect(await reg.taskIdAt(0)).to.equal(TASK_ID);
    expect(await reg.allTaskIds()).to.deep.equal([TASK_ID]);
  });

  it("rejects bad inputs", async () => {
    const { reg, gate } = await loadFixture(deploy);
    await expect(
      reg.setTaskType(ethers.ZeroHash, SPEC, SFT, gate.address, ONE, 0n, false, true)
    ).to.be.revertedWithCustomError(reg, "ZeroTaskId");
    await expect(
      reg.setTaskType(TASK_ID, SPEC, SFT, ethers.ZeroAddress, ONE, 0n, false, true)
    ).to.be.revertedWithCustomError(reg, "ZeroVerificationGate");
    await expect(
      reg.setTaskType(TASK_ID, SPEC, SFT, gate.address, 0n, 0n, false, true)
    ).to.be.revertedWithCustomError(reg, "ZeroShareWeight");
  });

  it("only GOVERNOR_ROLE may set / enable", async () => {
    const { reg, gate, outsider } = await loadFixture(deploy);
    await expect(
      reg.connect(outsider).setTaskType(TASK_ID, SPEC, SFT, gate.address, ONE, 0n, false, true)
    ).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");

    await reg.setTaskType(TASK_ID, SPEC, SFT, gate.address, ONE, 0n, false, true);
    await expect(reg.connect(outsider).setEnabled(TASK_ID, false)).to.be.revertedWithCustomError(
      reg,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("setEnabled flips flag and reverts on unknown", async () => {
    const { reg, gate } = await loadFixture(deploy);
    await reg.setTaskType(TASK_ID, SPEC, SFT, gate.address, ONE, 0n, false, true);
    await expect(reg.setEnabled(TASK_ID, false)).to.emit(reg, "HumanTaskTypeEnabled").withArgs(TASK_ID, false);
    expect(await reg.isEnabled(TASK_ID)).to.equal(false);

    await expect(reg.setEnabled(ethers.id("nope"), true)).to.be.revertedWithCustomError(reg, "UnknownTask");
  });

  it("update is idempotent on taskId (no duplicate enumeration)", async () => {
    const { reg, gate } = await loadFixture(deploy);
    await reg.setTaskType(TASK_ID, SPEC, SFT, gate.address, ONE, 0n, false, true);
    await reg.setTaskType(TASK_ID, SPEC, PREFERENCE_RANK, gate.address, 3n * ONE, 2n, true, false);
    expect(await reg.taskCount()).to.equal(1n);
    const t = await reg.taskType(TASK_ID);
    expect(t.shareWeight).to.equal(3n * ONE);
    expect(t.kind).to.equal(PREFERENCE_RANK);
  });
});
