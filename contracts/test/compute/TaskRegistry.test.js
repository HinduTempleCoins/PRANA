const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const id = (s) => ethers.id(s);

describe("TaskRegistry (RR1)", function () {
  const HATHOR = id("hathor-inference");
  const SCIENCE = id("protein-fold");
  const SPEC = ethers.id("spec-v1");

  async function deployFixture() {
    const [admin, gov, outsider, gate] = await ethers.getSigners();
    const TR = await ethers.getContractFactory("TaskRegistry");
    const registry = await TR.deploy(admin.address);
    return { registry, admin, gov, outsider, gate };
  }

  it("constructor grants admin DEFAULT_ADMIN + GOVERNOR roles; rejects zero admin", async () => {
    const { registry, admin } = await loadFixture(deployFixture);
    const GOV = await registry.GOVERNOR_ROLE();
    const DEFAULT = await registry.DEFAULT_ADMIN_ROLE();
    expect(await registry.hasRole(GOV, admin.address)).to.equal(true);
    expect(await registry.hasRole(DEFAULT, admin.address)).to.equal(true);
    const TR = await ethers.getContractFactory("TaskRegistry");
    await expect(TR.deploy(ethers.ZeroAddress)).to.be.revertedWith("admin=0");
  });

  it("setTaskType registers an entry and emits TaskTypeSet", async () => {
    const { registry, admin, gate } = await loadFixture(deployFixture);
    await expect(registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, WAD, 50, true))
      .to.emit(registry, "TaskTypeSet")
      .withArgs(HATHOR, SPEC, gate.address, WAD, 50, true);

    const t = await registry.taskType(HATHOR);
    expect(t.specHash).to.equal(SPEC);
    expect(t.verificationGate).to.equal(gate.address);
    expect(t.shareWeight).to.equal(WAD);
    expect(t.priority).to.equal(50n);
    expect(t.enabled).to.equal(true);

    expect(await registry.isEnabled(HATHOR)).to.equal(true);
    expect(await registry.shareWeight(HATHOR)).to.equal(WAD);
    expect(await registry.priorityOf(HATHOR)).to.equal(50n);
    expect(await registry.isKnown(HATHOR)).to.equal(true);
    expect(await registry.taskCount()).to.equal(1n);
    expect(await registry.taskIdAt(0)).to.equal(HATHOR);
    expect(await registry.allTaskIds()).to.deep.equal([HATHOR]);
  });

  it("rejects bad params", async () => {
    const { registry, admin, gate } = await loadFixture(deployFixture);
    await expect(registry.connect(admin).setTaskType(ethers.ZeroHash, SPEC, gate.address, WAD, 1, true))
      .to.be.revertedWithCustomError(registry, "ZeroTaskId");
    await expect(registry.connect(admin).setTaskType(HATHOR, SPEC, ethers.ZeroAddress, WAD, 1, true))
      .to.be.revertedWithCustomError(registry, "ZeroVerificationGate");
    await expect(registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, 0, 1, true))
      .to.be.revertedWithCustomError(registry, "ZeroShareWeight");
  });

  it("only GOVERNOR_ROLE may mutate", async () => {
    const { registry, outsider, gate } = await loadFixture(deployFixture);
    await expect(registry.connect(outsider).setTaskType(HATHOR, SPEC, gate.address, WAD, 1, true))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await expect(registry.connect(outsider).setEnabled(HATHOR, false))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });

  it("setTaskType is idempotent (overwrite, no duplicate enumeration)", async () => {
    const { registry, admin, gate } = await loadFixture(deployFixture);
    await registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, WAD, 50, true);
    await registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, 2n * WAD, 99, false);
    expect(await registry.taskCount()).to.equal(1n);
    const t = await registry.taskType(HATHOR);
    expect(t.shareWeight).to.equal(2n * WAD);
    expect(t.priority).to.equal(99n);
    expect(t.enabled).to.equal(false);
  });

  it("setEnabled flips the flag and reverts on unknown task", async () => {
    const { registry, admin, gate } = await loadFixture(deployFixture);
    await expect(registry.connect(admin).setEnabled(HATHOR, false))
      .to.be.revertedWithCustomError(registry, "UnknownTask");
    await registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, WAD, 50, true);
    await expect(registry.connect(admin).setEnabled(HATHOR, false))
      .to.emit(registry, "TaskTypeEnabled").withArgs(HATHOR, false);
    expect(await registry.isEnabled(HATHOR)).to.equal(false);
    await registry.connect(admin).setEnabled(HATHOR, true);
    expect(await registry.isEnabled(HATHOR)).to.equal(true);
  });

  it("enumerates multiple task-types", async () => {
    const { registry, admin, gate } = await loadFixture(deployFixture);
    await registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, WAD, 50, true);
    await registry.connect(admin).setTaskType(SCIENCE, SPEC, gate.address, WAD / 2n, 10, true);
    expect(await registry.taskCount()).to.equal(2n);
    expect(await registry.allTaskIds()).to.deep.equal([HATHOR, SCIENCE]);
  });

  it("unregistered task reads as the zero-struct / disabled", async () => {
    const { registry } = await loadFixture(deployFixture);
    expect(await registry.isEnabled(SCIENCE)).to.equal(false);
    expect(await registry.shareWeight(SCIENCE)).to.equal(0n);
    expect(await registry.isKnown(SCIENCE)).to.equal(false);
  });
});
