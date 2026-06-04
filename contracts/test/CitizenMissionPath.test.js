const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("CitizenMissionPath", function () {
  const DAY_BLOCKS = 50;
  const WALK_COOLDOWN = 5;
  const START = 1;

  const REF1 = ethers.id("mission:gate");
  const REF2 = ethers.id("mission:forge");
  const REF3 = ethers.id("mission:peak");

  const FIRST_REWARD = 1000n;
  const REPLAY_BPS = 2500n; // 25% on replays

  async function deployFixture() {
    const [admin, alice, bob, outsider] = await ethers.getSigners();

    const PoL = await ethers.getContractFactory("PoLToken");
    const reward = await PoL.deploy(admin.address);

    const Path = await ethers.getContractFactory("CitizenMissionPath");
    const path = await Path.deploy(
      await reward.getAddress(),
      DAY_BLOCKS,
      WALK_COOLDOWN,
      START,
      admin.address
    );

    // path must hold the minter role on the reward token
    await reward.grantRole(await reward.MINTER_ROLE(), await path.getAddress());

    // node graph: 1 -> 2 -> 3, with 1->2 and 2->3 edges
    await path.configureNode(1, REF1, FIRST_REWARD, REPLAY_BPS, 3);
    await path.configureNode(2, REF2, FIRST_REWARD, REPLAY_BPS, 3);
    await path.configureNode(3, REF3, FIRST_REWARD, 0n, 2); // node 3 has no replay reward
    await path.setEdge(1, 2, true);
    await path.setEdge(2, 3, true);

    return { path, reward, admin, alice, bob, outsider };
  }

  it("deploys with expected config and spawn position", async () => {
    const { path, reward } = await loadFixture(deployFixture);
    expect(await path.rewardToken()).to.equal(await reward.getAddress());
    expect(await path.startNode()).to.equal(BigInt(START));
    // citizen defaults to start node before any interaction
    const [, alice] = await ethers.getSigners();
    expect(await path.positionOf(alice.address)).to.equal(BigInt(START));
  });

  it("walk is gated by edge adjacency", async () => {
    const { path, alice } = await loadFixture(deployFixture);
    // no edge 1 -> 3
    await expect(path.connect(alice).walk(3))
      .to.be.revertedWithCustomError(path, "NoEdge");

    await expect(path.connect(alice).walk(2))
      .to.emit(path, "Walked")
      .withArgs(alice.address, 1, 2);
    expect(await path.positionOf(alice.address)).to.equal(2n);
  });

  it("walk respects the move cadence (cooldown)", async () => {
    const { path, alice } = await loadFixture(deployFixture);
    await path.connect(alice).walk(2); // first walk sets lastWalkBlock

    // immediate next walk is on cooldown
    await expect(path.connect(alice).walk(3))
      .to.be.revertedWithCustomError(path, "WalkOnCooldown");

    await mine(WALK_COOLDOWN);
    await expect(path.connect(alice).walk(3))
      .to.emit(path, "Walked")
      .withArgs(alice.address, 2, 3);
  });

  it("attemptMission requires the citizen to stand on the node", async () => {
    const { path, alice } = await loadFixture(deployFixture);
    // citizen is on node 1; attempting node 2 reverts
    await expect(path.connect(alice).attemptMission(2))
      .to.be.revertedWithCustomError(path, "NotAtNode");
  });

  it("first clear pays full reward + ranks up; replay pays the bps fraction", async () => {
    const { path, reward, alice } = await loadFixture(deployFixture);

    // first clear of node 1
    await expect(path.connect(alice).attemptMission(1))
      .to.emit(path, "MissionCleared")
      .withArgs(alice.address, 1, FIRST_REWARD, true, 1n);
    expect(await reward.balanceOf(alice.address)).to.equal(FIRST_REWARD);
    expect(await path.rankOf(alice.address)).to.equal(1n);

    // replay of node 1 pays 25% and does NOT rank up
    const replay = (FIRST_REWARD * REPLAY_BPS) / 10000n; // 250
    await expect(path.connect(alice).attemptMission(1))
      .to.emit(path, "MissionCleared")
      .withArgs(alice.address, 1, replay, false, 1n);
    expect(await reward.balanceOf(alice.address)).to.equal(FIRST_REWARD + replay);
    expect(await path.rankOf(alice.address)).to.equal(1n);
  });

  it("rank increments on each distinct first-clear as the citizen walks", async () => {
    const { path, alice } = await loadFixture(deployFixture);

    await path.connect(alice).attemptMission(1); // rank 1
    await path.connect(alice).walk(2);
    await path.connect(alice).attemptMission(2); // rank 2
    await mine(WALK_COOLDOWN);
    await path.connect(alice).walk(3);
    await path.connect(alice).attemptMission(3); // rank 3

    expect(await path.rankOf(alice.address)).to.equal(3n);
  });

  it("enforces the per-node per-day attempt cap and rolls over the next day", async () => {
    const { path, reward, alice } = await loadFixture(deployFixture);

    // node 1 cap = 3 attempts/day
    await path.connect(alice).attemptMission(1); // 1 (first clear)
    await path.connect(alice).attemptMission(1); // 2 (replay)
    await path.connect(alice).attemptMission(1); // 3 (replay)
    expect(await path.attemptsToday(alice.address, 1)).to.equal(3n);

    await expect(path.connect(alice).attemptMission(1))
      .to.be.revertedWithCustomError(path, "DailyCapReached");

    // advance to the next day window -> cap resets
    await mine(DAY_BLOCKS);
    expect(await path.attemptsToday(alice.address, 1)).to.equal(0n);
    await expect(path.connect(alice).attemptMission(1)).to.emit(path, "MissionCleared");
  });

  it("node with zero replayBps pays nothing on replay", async () => {
    const { path, reward, alice } = await loadFixture(deployFixture);
    // walk to node 3
    await path.connect(alice).walk(2);
    await mine(WALK_COOLDOWN);
    await path.connect(alice).walk(3);

    await path.connect(alice).attemptMission(3); // first clear: full
    const afterFirst = await reward.balanceOf(alice.address);
    expect(afterFirst).to.equal(FIRST_REWARD);

    await path.connect(alice).attemptMission(3); // replay: 0 bps -> 0
    expect(await reward.balanceOf(alice.address)).to.equal(afterFirst);
  });

  it("per-player isolation: each player has their own first-clear and rank", async () => {
    const { path, reward, alice, bob } = await loadFixture(deployFixture);

    await path.connect(alice).attemptMission(1); // alice first clear
    // bob's first clear of the SAME node still pays full (per-player, not global)
    await expect(path.connect(bob).attemptMission(1))
      .to.emit(path, "MissionCleared")
      .withArgs(bob.address, 1, FIRST_REWARD, true, 1n);
    expect(await reward.balanceOf(bob.address)).to.equal(FIRST_REWARD);
    expect(await path.rankOf(bob.address)).to.equal(1n);
  });

  it("admin-only node/edge config; replayBps > 100% reverts", async () => {
    const { path, outsider } = await loadFixture(deployFixture);
    await expect(path.connect(outsider).configureNode(9, REF1, 1n, 0n, 0n))
      .to.be.revertedWithCustomError(path, "AccessControlUnauthorizedAccount");
    await expect(path.configureNode(10, REF1, 1n, 10001n, 0n))
      .to.be.revertedWithCustomError(path, "BadParams");
  });
});
