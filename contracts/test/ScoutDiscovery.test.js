const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("ScoutDiscovery", function () {
  const ZONE = 1;
  const CADENCE = 5; // blocks a scout must roam before resolve
  const REF_NODE = ethers.id("node:spring");
  const REF_DOOR = ethers.id("door:vault");

  // Kind enum: 0 NodeReveal, 1 HiddenDoorway, 2 FragmentDrop
  const KIND_NODE = 0;
  const KIND_DOOR = 1;

  function clueHash(clue) {
    return ethers.keccak256(ethers.solidityPacked(["bytes32"], [clue]));
  }

  async function deployFixture() {
    const [admin, alice, bob, outsider] = await ethers.getSigners();

    const Scout = await ethers.getContractFactory("ScoutDiscovery");
    const scout = await Scout.deploy(admin.address);

    await scout.configureZone(ZONE, CADENCE);

    return { scout, admin, alice, bob, outsider };
  }

  async function withSingleDiscoverable(scout, maxFinds) {
    // exactly one entry => any non-depleted draw lands on index 0 (deterministic outcome)
    await scout.addDiscoverable(ZONE, KIND_NODE, REF_NODE, 100, maxFinds);
  }

  it("configures zones and discoverables", async () => {
    const { scout } = await loadFixture(deployFixture);
    await withSingleDiscoverable(scout, 0);
    expect(await scout.tableLength(ZONE)).to.equal(1n);
    const d = await scout.discoverableAt(ZONE, 0);
    expect(d.ref).to.equal(REF_NODE);
    expect(d.weight).to.equal(100n);
  });

  it("dispatch is clue-gated and one-active-per-zone", async () => {
    const { scout, alice } = await loadFixture(deployFixture);
    const clue = ethers.hexlify(ethers.randomBytes(32));

    await expect(scout.connect(alice).dispatch(ZONE, ethers.ZeroHash))
      .to.be.revertedWithCustomError(scout, "ZeroClueHash");

    await expect(scout.connect(alice).dispatch(ZONE, clueHash(clue)))
      .to.emit(scout, "ScoutDispatched");

    // second dispatch while active reverts
    await expect(scout.connect(alice).dispatch(ZONE, clueHash(clue)))
      .to.be.revertedWithCustomError(scout, "ScoutActive");
  });

  it("dispatch to an unknown zone reverts", async () => {
    const { scout, alice } = await loadFixture(deployFixture);
    const clue = ethers.hexlify(ethers.randomBytes(32));
    await expect(scout.connect(alice).dispatch(999, clueHash(clue)))
      .to.be.revertedWithCustomError(scout, "UnknownZone");
  });

  it("resolve enforces the cadence and the clue", async () => {
    const { scout, alice } = await loadFixture(deployFixture);
    await withSingleDiscoverable(scout, 0);
    const clue = ethers.hexlify(ethers.randomBytes(32));
    const wrong = ethers.hexlify(ethers.randomBytes(32));

    await scout.connect(alice).dispatch(ZONE, clueHash(clue));

    // too early: reveal block (dispatch + CADENCE) not yet mined
    await expect(scout.connect(alice).resolve(ZONE, clue))
      .to.be.revertedWithCustomError(scout, "TooEarly");

    await mine(CADENCE + 1);

    // wrong clue reverts even after cadence
    await expect(scout.connect(alice).resolve(ZONE, wrong))
      .to.be.revertedWithCustomError(scout, "BadClue");

    // correct clue resolves to the only entry deterministically
    await expect(scout.connect(alice).resolve(ZONE, clue))
      .to.emit(scout, "Discovered")
      .withArgs(ZONE, alice.address, 0, KIND_NODE, REF_NODE);

    // scout slot freed -> can redispatch
    const clue2 = ethers.hexlify(ethers.randomBytes(32));
    await scout.connect(alice).dispatch(ZONE, clueHash(clue2));
  });

  it("resolve without a dispatched scout reverts", async () => {
    const { scout, alice } = await loadFixture(deployFixture);
    await withSingleDiscoverable(scout, 0);
    const clue = ethers.hexlify(ethers.randomBytes(32));
    await expect(scout.connect(alice).resolve(ZONE, clue))
      .to.be.revertedWithCustomError(scout, "NoScout");
  });

  it("depletes a discoverable at maxFinds (re-normalizes it out)", async () => {
    const { scout, alice, bob } = await loadFixture(deployFixture);
    // single entry with maxFinds = 1 -> second resolve finds nothing
    await withSingleDiscoverable(scout, 1);

    const clueA = ethers.hexlify(ethers.randomBytes(32));
    await scout.connect(alice).dispatch(ZONE, clueHash(clueA));
    await mine(CADENCE + 1);
    await expect(scout.connect(alice).resolve(ZONE, clueA))
      .to.emit(scout, "Discovered");

    expect(await scout.isDepleted(ZONE, 0)).to.equal(true);

    // bob now finds nothing because the only entry is depleted
    const clueB = ethers.hexlify(ethers.randomBytes(32));
    await scout.connect(bob).dispatch(ZONE, clueHash(clueB));
    await mine(CADENCE + 1);
    const tx = await scout.connect(bob).resolve(ZONE, clueB);
    await expect(tx).to.emit(scout, "NothingFound").withArgs(ZONE, bob.address);
  });

  it("a second discoverable is still found after the first depletes", async () => {
    const { scout, alice, bob } = await loadFixture(deployFixture);
    // index 0 depletes after 1 find; index 1 unlimited -> after depletion, index 1 is forced
    await scout.addDiscoverable(ZONE, KIND_NODE, REF_NODE, 100, 1);
    await scout.addDiscoverable(ZONE, KIND_DOOR, REF_DOOR, 100, 0);

    // exhaust index 0 directly via many resolves until it's depleted, then assert index 1 forced
    // simplest deterministic check: deplete index 0 by hand is non-trivial (random draw),
    // so instead verify that once index 0 IS depleted, the draw can only return index 1.
    // Force depletion: keep resolving alice until index0.finds == 1.
    let depleted = await scout.isDepleted(ZONE, 0);
    let signer = alice;
    let n = 0;
    while (!depleted && n < 30) {
      const clue = ethers.hexlify(ethers.randomBytes(32));
      await scout.connect(signer).dispatch(ZONE, clueHash(clue));
      await mine(CADENCE + 1);
      await scout.connect(signer).resolve(ZONE, clue);
      depleted = await scout.isDepleted(ZONE, 0);
      signer = signer === alice ? bob : alice;
      n++;
    }
    expect(depleted).to.equal(true);

    // now index 1 is the only available entry -> deterministic
    const clueF = ethers.hexlify(ethers.randomBytes(32));
    await scout.connect(alice).dispatch(ZONE, clueHash(clueF));
    await mine(CADENCE + 1);
    await expect(scout.connect(alice).resolve(ZONE, clueF))
      .to.emit(scout, "Discovered")
      .withArgs(ZONE, alice.address, 1, KIND_DOOR, REF_DOOR);
  });

  it("expired scout can be recalled, freeing the slot", async () => {
    const { scout, alice } = await loadFixture(deployFixture);
    await withSingleDiscoverable(scout, 0);
    const clue = ethers.hexlify(ethers.randomBytes(32));
    await scout.connect(alice).dispatch(ZONE, clueHash(clue));

    // before expiry, recall reverts
    await mine(CADENCE + 1);
    await expect(scout.connect(alice).recall(ZONE))
      .to.be.revertedWithCustomError(scout, "TooEarly");

    // push reveal block out of the lookback window
    await mine(300);
    await expect(scout.connect(alice).resolve(ZONE, clue))
      .to.be.revertedWithCustomError(scout, "TooLate");
    await expect(scout.connect(alice).recall(ZONE))
      .to.emit(scout, "ScoutRecalled")
      .withArgs(ZONE, alice.address);

    // slot freed
    await scout.connect(alice).dispatch(ZONE, clueHash(clue));
  });

  it("only admin can configure zones / discoverables", async () => {
    const { scout, outsider } = await loadFixture(deployFixture);
    await expect(scout.connect(outsider).configureZone(2, 3))
      .to.be.revertedWithCustomError(scout, "AccessControlUnauthorizedAccount");
    await expect(scout.connect(outsider).addDiscoverable(ZONE, KIND_NODE, REF_NODE, 1, 0))
      .to.be.revertedWithCustomError(scout, "AccessControlUnauthorizedAccount");
  });
});
