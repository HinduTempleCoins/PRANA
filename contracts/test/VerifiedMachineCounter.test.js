const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const id = (s) => ethers.id(s);

describe("VerifiedMachineCounter", function () {
  let counter, admin, registrar, other;
  // 7-bucket window, 1 day each => must heartbeat every day for a week to be "sustained".
  const DAY = 24 * 60 * 60;
  const WINDOW = 7 * DAY;
  const BUCKETS = 7;

  beforeEach(async () => {
    [admin, registrar, other] = await ethers.getSigners();
    const C = await ethers.getContractFactory("VerifiedMachineCounter");
    counter = await C.deploy(admin.address, WINDOW, BUCKETS);
    const ROLE = await counter.REGISTRAR_ROLE();
    await counter.grantRole(ROLE, registrar.address);
  });

  // Beat in the current bucket then advance to the next bucket boundary, for `n` buckets.
  async function beatAcrossBuckets(machineId, n) {
    for (let i = 0; i < n; i++) {
      await counter.connect(registrar).heartbeat(machineId);
      await time.increase(DAY);
    }
  }

  it("rejects bad window config", async () => {
    const C = await ethers.getContractFactory("VerifiedMachineCounter");
    await expect(C.deploy(admin.address, WINDOW, 0)).to.be.revertedWithCustomError(C, "BadWindow");
    await expect(C.deploy(admin.address, WINDOW, 300)).to.be.revertedWithCustomError(C, "BadWindow");
    // not divisible
    await expect(C.deploy(admin.address, 10, 3)).to.be.revertedWithCustomError(C, "BadWindow");
  });

  it("only the registrar can register / heartbeat", async () => {
    const m = id("m1");
    await expect(counter.connect(other).registerMachine(m)).to.be.reverted;
    await counter.connect(registrar).registerMachine(m);
    await expect(counter.connect(other).heartbeat(m)).to.be.reverted;
  });

  it("registering does not by itself make a machine count", async () => {
    const m = id("m1");
    await counter.connect(registrar).registerMachine(m);
    expect(await counter.isRegistered(m)).to.equal(true);
    expect(await counter.sustainedCount()).to.equal(0n);
    expect(await counter.isSustained(m)).to.equal(false);
  });

  it("heartbeat requires registration", async () => {
    await expect(counter.connect(registrar).heartbeat(id("ghost"))).to.be.revertedWithCustomError(
      counter,
      "NotRegistered"
    );
  });

  it("counts a machine only after it sustains across the WHOLE window", async () => {
    const m = id("steady");
    await counter.connect(registrar).registerMachine(m);

    // Beat in 6 consecutive buckets — still one slice short of the full 7-bucket window.
    await beatAcrossBuckets(m, 6);
    expect(await counter.isSustained(m)).to.equal(false);
    expect(await counter.sustainedCount()).to.equal(0n);

    // 7th consecutive bucket completes the window.
    await counter.connect(registrar).heartbeat(m);
    expect(await counter.isSustained(m)).to.equal(true);
    expect(await counter.sustainedCount()).to.equal(1n);
  });

  it("a single-bucket SPIKE of many machines does NOT trip the count", async () => {
    // Register 50 machines and beat each ONCE in the same bucket. None are sustained.
    const ids = [];
    for (let i = 0; i < 50; i++) {
      const m = id("spike" + i);
      ids.push(m);
      await counter.connect(registrar).registerMachine(m);
      await counter.connect(registrar).heartbeat(m);
    }
    expect(await counter.sustainedCount()).to.equal(0n);

    // Even after time passes (without continued beats) they decay, never having sustained.
    await time.increase(WINDOW + DAY);
    expect(await counter.sustainedCount()).to.equal(0n);
  });

  it("decays a machine that goes idle (drops out of the window)", async () => {
    const m = id("idler");
    await counter.connect(registrar).registerMachine(m);
    // Fill the window.
    await beatAcrossBuckets(m, 6);
    await counter.connect(registrar).heartbeat(m);
    expect(await counter.sustainedCount()).to.equal(1n);

    // Go idle: after `buckets` empty buckets the beats roll out of the window entirely.
    await time.increase(WINDOW);
    expect(await counter.isSustained(m)).to.equal(false);
    expect(await counter.sustainedCount()).to.equal(0n);
  });

  it("counts multiple sustained machines", async () => {
    const a = id("a");
    const b = id("b");
    await counter.connect(registrar).registerMachine(a);
    await counter.connect(registrar).registerMachine(b);
    // Beat both every bucket across the window.
    for (let i = 0; i < BUCKETS - 1; i++) {
      await counter.connect(registrar).heartbeat(a);
      await counter.connect(registrar).heartbeat(b);
      await time.increase(DAY);
    }
    await counter.connect(registrar).heartbeat(a);
    await counter.connect(registrar).heartbeat(b);
    expect(await counter.sustainedCount()).to.equal(2n);
  });

  it("a gap in the middle of the window breaks the sustain", async () => {
    const m = id("gappy");
    await counter.connect(registrar).registerMachine(m);
    // Beat buckets 0,1,2 then SKIP bucket 3, then beat 4,5,6.
    for (let i = 0; i < 3; i++) {
      await counter.connect(registrar).heartbeat(m);
      await time.increase(DAY);
    }
    await time.increase(DAY); // skipped bucket
    for (let i = 0; i < 3; i++) {
      await counter.connect(registrar).heartbeat(m);
      await time.increase(DAY);
    }
    expect(await counter.isSustained(m)).to.equal(false);
  });
});
