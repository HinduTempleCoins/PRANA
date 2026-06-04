const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const DAY = 24 * 60 * 60;
const TWO_YEARS = 730 * DAY;

describe("RegentGovernance (QQ1)", function () {
  const INITIAL = 1000n * WAD;

  async function deployFixture() {
    const [admin, other, newAdmin] = await ethers.getSigners();
    const now = await time.latest();
    const start = now + 100; // start slightly in the future to test pre-start plateau
    const RG = await ethers.getContractFactory("RegentGovernance");
    const regent = await RG.deploy(admin.address, INITIAL, start, TWO_YEARS);
    return { regent, admin, other, newAdmin, start };
  }

  it("constructor validates params and publishes the schedule", async () => {
    const [admin] = await ethers.getSigners();
    const RG = await ethers.getContractFactory("RegentGovernance");
    await expect(RG.deploy(ethers.ZeroAddress, INITIAL, 0, TWO_YEARS)).to.be.revertedWithCustomError(RG, "ZeroAddress");
    await expect(RG.deploy(admin.address, 0, 0, TWO_YEARS)).to.be.revertedWithCustomError(RG, "ZeroInitialWeight");
    await expect(RG.deploy(admin.address, INITIAL, 0, 0)).to.be.revertedWithCustomError(RG, "ZeroDuration");

    const now = await time.latest();
    await expect(RG.deploy(admin.address, INITIAL, 0, TWO_YEARS)).to.emit; // start=0 ⇒ now
    const regent = await RG.deploy(admin.address, INITIAL, 0, TWO_YEARS);
    const start = await regent.start();
    expect(start).to.be.greaterThanOrEqual(BigInt(now));
    expect(await regent.end()).to.equal(start + BigInt(TWO_YEARS));
    expect(await regent.initialWeight()).to.equal(INITIAL);
  });

  it("holds full weight at and before start", async () => {
    const { regent, start } = await loadFixture(deployFixture);
    expect(await regent.weightAt(0)).to.equal(INITIAL);
    expect(await regent.weightAt(start)).to.equal(INITIAL);
  });

  it("decays linearly: ~half weight at the midpoint", async () => {
    const { regent, start } = await loadFixture(deployFixture);
    const mid = start + TWO_YEARS / 2;
    const w = await regent.weightAt(mid);
    // exactly initial * (end-mid)/duration = initial/2
    expect(w).to.equal(INITIAL / 2n);
  });

  it("hits EXACTLY zero at end and stays zero after", async () => {
    const { regent, start } = await loadFixture(deployFixture);
    const end = start + TWO_YEARS;
    expect(await regent.weightAt(end)).to.equal(0n);
    expect(await regent.weightAt(end + 1)).to.equal(0n);
    expect(await regent.weightAt(end + TWO_YEARS)).to.equal(0n);
    // just before end is strictly positive but < initial
    const justBefore = await regent.weightAt(end - 1);
    expect(justBefore).to.be.greaterThan(0n);
    expect(justBefore).to.be.lessThan(INITIAL);
  });

  it("is monotonic non-increasing across the whole schedule", async () => {
    const { regent, start } = await loadFixture(deployFixture);
    let prev = await regent.weightAt(start);
    const steps = 24; // 24 monthly steps
    for (let i = 1; i <= steps + 2; i++) {
      const t = start + Math.floor((TWO_YEARS * i) / steps);
      const w = await regent.weightAt(t);
      expect(w).to.be.lessThanOrEqual(prev);
      prev = w;
    }
    expect(prev).to.equal(0n);
  });

  it("live weight() tracks block.timestamp", async () => {
    const { regent, start } = await loadFixture(deployFixture);
    await time.increaseTo(start + TWO_YEARS / 4);
    const w = await regent.weight();
    // ~75% remaining
    expect(w).to.be.closeTo((INITIAL * 3n) / 4n, INITIAL / 1000n);
    await time.increaseTo(start + TWO_YEARS + 10);
    expect(await regent.weight()).to.equal(0n);
  });

  it("renounce zeroes weight immediately and forever; only admin; not twice", async () => {
    const { regent, admin, other, start } = await loadFixture(deployFixture);
    await time.increaseTo(start + TWO_YEARS / 4); // mid-schedule, weight > 0
    expect(await regent.weight()).to.be.greaterThan(0n);

    await expect(regent.connect(other).renounce()).to.be.revertedWithCustomError(regent, "NotAdmin");
    await expect(regent.connect(admin).renounce()).to.emit(regent, "RegentRenounced");

    expect(await regent.renounced()).to.equal(true);
    expect(await regent.weight()).to.equal(0n);
    // even historical lookups read 0 once renounced
    expect(await regent.weightAt(start)).to.equal(0n);

    await expect(regent.connect(admin).renounce()).to.be.revertedWithCustomError(regent, "AlreadyRenounced");
  });

  it("admin can transfer steering key but weight is unchanged", async () => {
    const { regent, admin, other, newAdmin, start } = await loadFixture(deployFixture);
    const before = await regent.weightAt(start);
    await expect(regent.connect(other).transferAdmin(newAdmin.address)).to.be.revertedWithCustomError(regent, "NotAdmin");
    await expect(regent.connect(admin).transferAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(regent, "ZeroAddress");
    await expect(regent.connect(admin).transferAdmin(newAdmin.address)).to.emit(regent, "AdminTransferred");
    expect(await regent.admin()).to.equal(newAdmin.address);
    expect(await regent.weightAt(start)).to.equal(before); // weight untouched
    // old admin can no longer renounce
    await expect(regent.connect(admin).renounce()).to.be.revertedWithCustomError(regent, "NotAdmin");
  });

  it("NO-SUPPLY-TOUCH by construction: holds no token, no value-moving surface", async () => {
    const { regent } = await loadFixture(deployFixture);
    const addr = await regent.getAddress();
    // No ether can be sent (no payable / receive / fallback).
    const [signer] = await ethers.getSigners();
    await expect(
      signer.sendTransaction({ to: addr, value: 1n })
    ).to.be.reverted;
    // Surface check: the ABI exposes no mint/transfer/emission/pool function.
    const fnNames = regent.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    for (const banned of ["mint", "transfer", "transferfrom", "withdraw", "claim", "emission", "rewards", "pool", "approve"]) {
      expect(fnNames).to.not.include(banned);
    }
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });
});
