const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const DAY = 24 * 60 * 60;
const ONE_YEAR = 365 * DAY;
const id = (s) => ethers.id(s);

describe("TaskDispatchPolicy (RR2)", function () {
  const HATHOR = id("hathor-inference");
  const SCIENCE = id("protein-fold");
  const RENDER = id("render-job");
  const SPEC = ethers.id("spec-v1");

  async function deployFixture() {
    const [admin, gov, outsider, gate] = await ethers.getSigners();
    const TR = await ethers.getContractFactory("TaskRegistry");
    const registry = await TR.deploy(admin.address);

    // Seed three enabled task-types with base priorities.
    await registry.connect(admin).setTaskType(HATHOR, SPEC, gate.address, WAD, 30, true);
    await registry.connect(admin).setTaskType(SCIENCE, SPEC, gate.address, WAD, 50, true);
    await registry.connect(admin).setTaskType(RENDER, SPEC, gate.address, WAD, 10, true);

    const TDP = await ethers.getContractFactory("TaskDispatchPolicy");
    const policy = await TDP.deploy(await registry.getAddress(), admin.address);
    return { registry, policy, admin, gov, outsider, gate };
  }

  it("constructor validates registry + admin", async () => {
    const { registry, admin } = await loadFixture(deployFixture);
    const TDP = await ethers.getContractFactory("TaskDispatchPolicy");
    await expect(TDP.deploy(ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(TDP, "ZeroRegistry");
    await expect(TDP.deploy(await registry.getAddress(), ethers.ZeroAddress)).to.be.revertedWith("admin=0");
  });

  it("effectivePriority = base when no boosts/anchor", async () => {
    const { policy } = await loadFixture(deployFixture);
    expect(await policy.effectivePriority(SCIENCE)).to.equal(50n);
    expect(await policy.effectivePriority(HATHOR)).to.equal(30n);
  });

  it("ranks enabled task-types by descending effective priority", async () => {
    const { policy } = await loadFixture(deployFixture);
    const [ids, prios] = await policy.rankedEnabled();
    expect(ids).to.deep.equal([SCIENCE, HATHOR, RENDER]);
    expect(prios).to.deep.equal([50n, 30n, 10n]);
    const [topId, topP] = await policy.topTask();
    expect(topId).to.equal(SCIENCE);
    expect(topP).to.equal(50n);
  });

  it("governed per-task boost adds to effective priority", async () => {
    const { policy, admin } = await loadFixture(deployFixture);
    await expect(policy.connect(admin).setPriorityBoost(HATHOR, 100))
      .to.emit(policy, "PriorityBoostSet").withArgs(HATHOR, 100);
    expect(await policy.effectivePriority(HATHOR)).to.equal(130n); // 30 + 100
    const [topId] = await policy.topTask();
    expect(topId).to.equal(HATHOR);
  });

  it("only GOVERNOR may set boost / anchor; rejects unknown task", async () => {
    const { policy, outsider, admin } = await loadFixture(deployFixture);
    await expect(policy.connect(outsider).setPriorityBoost(HATHOR, 1))
      .to.be.revertedWithCustomError(policy, "AccessControlUnauthorizedAccount");
    await expect(policy.connect(admin).setPriorityBoost(id("nope"), 1))
      .to.be.revertedWithCustomError(policy, "UnknownTask");
    await expect(policy.connect(admin).setAnchor(id("nope"), 1, (await time.latest()) + ONE_YEAR))
      .to.be.revertedWithCustomError(policy, "UnknownTask");
  });

  describe("anchor reservation (Hathor priority for ≥1yr)", function () {
    it("sets anchor and boosts the reserved task while active", async () => {
      const { policy, admin } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + ONE_YEAR;
      // Hathor base 30 vs Science 50; give Hathor a +40 anchor → 70, beats Science.
      await expect(policy.connect(admin).setAnchor(HATHOR, 40, expiry))
        .to.emit(policy, "AnchorSet").withArgs(HATHOR, 40, expiry);

      expect(await policy.anchorActive()).to.equal(true);
      expect(await policy.activeAnchorBoost(HATHOR)).to.equal(40n);
      expect(await policy.activeAnchorBoost(SCIENCE)).to.equal(0n);
      expect(await policy.effectivePriority(HATHOR)).to.equal(70n);

      const [topId, topP] = await policy.topTask();
      expect(topId).to.equal(HATHOR);
      expect(topP).to.equal(70n);
    });

    it("anchor boost VANISHES at/after expiry with no transaction", async () => {
      const { policy, admin } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + ONE_YEAR;
      await policy.connect(admin).setAnchor(HATHOR, 40, expiry);
      expect(await policy.effectivePriority(HATHOR)).to.equal(70n);

      await time.increaseTo(expiry + 1);
      expect(await policy.anchorActive()).to.equal(false);
      expect(await policy.activeAnchorBoost(HATHOR)).to.equal(0n);
      expect(await policy.effectivePriority(HATHOR)).to.equal(30n); // back to base
      const [topId] = await policy.topTask();
      expect(topId).to.equal(SCIENCE); // reservation lapsed, normal ranking resumes
    });

    it("rejects an expiry that is not in the future", async () => {
      const { policy, admin } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(policy.connect(admin).setAnchor(HATHOR, 40, now))
        .to.be.revertedWithCustomError(policy, "ExpiryInPast");
    });

    it("anchor can be re-pointed and cleared before expiry", async () => {
      const { policy, admin } = await loadFixture(deployFixture);
      const expiry = (await time.latest()) + ONE_YEAR;
      await policy.connect(admin).setAnchor(HATHOR, 40, expiry);
      // re-point to SCIENCE
      await policy.connect(admin).setAnchor(SCIENCE, 5, expiry);
      expect(await policy.activeAnchorBoost(HATHOR)).to.equal(0n);
      expect(await policy.activeAnchorBoost(SCIENCE)).to.equal(5n);
      // clear
      await expect(policy.connect(admin).clearAnchor())
        .to.emit(policy, "AnchorCleared").withArgs(SCIENCE);
      expect(await policy.anchorActive()).to.equal(false);
      expect(await policy.activeAnchorBoost(SCIENCE)).to.equal(0n);
    });
  });

  it("disabled task-types are excluded from ranking", async () => {
    const { registry, policy, admin } = await loadFixture(deployFixture);
    await registry.connect(admin).setEnabled(SCIENCE, false);
    const [ids] = await policy.rankedEnabled();
    expect(ids).to.deep.equal([HATHOR, RENDER]);
    const [topId] = await policy.topTask();
    expect(topId).to.equal(HATHOR);
  });

  it("rankedEnabled reverts EmptyCatalog when nothing is registered", async () => {
    const { admin } = await loadFixture(deployFixture);
    const TR = await ethers.getContractFactory("TaskRegistry");
    const empty = await TR.deploy(admin.address);
    const TDP = await ethers.getContractFactory("TaskDispatchPolicy");
    const policy = await TDP.deploy(await empty.getAddress(), admin.address);
    await expect(policy.rankedEnabled()).to.be.revertedWithCustomError(policy, "EmptyCatalog");
    await expect(policy.topTask()).to.be.revertedWithCustomError(policy, "EmptyCatalog");
  });

  it("rankedEnabled returns empty (no revert) when registered but none enabled", async () => {
    const { registry, policy, admin } = await loadFixture(deployFixture);
    await registry.connect(admin).setEnabled(HATHOR, false);
    await registry.connect(admin).setEnabled(SCIENCE, false);
    await registry.connect(admin).setEnabled(RENDER, false);
    const [ids, prios] = await policy.rankedEnabled();
    expect(ids).to.deep.equal([]);
    expect(prios).to.deep.equal([]);
    await expect(policy.topTask()).to.be.revertedWithCustomError(policy, "EmptyCatalog");
  });
});
