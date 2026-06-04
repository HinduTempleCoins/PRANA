const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const DAY = 24 * 60 * 60;
const TWO_YEARS = 730 * DAY;

describe("RegentVotesAdapter (QQ2)", function () {
  const INITIAL = 1000n * WAD;

  async function deployFixture() {
    const [admin, regentAcct, voter] = await ethers.getSigners();
    const now = await time.latest();
    const start = now; // start now for clean past-lookups
    const RG = await ethers.getContractFactory("RegentGovernance");
    const regent = await RG.deploy(admin.address, INITIAL, start, TWO_YEARS);
    const Adapter = await ethers.getContractFactory("RegentVotesAdapter");
    const adapter = await Adapter.deploy(await regent.getAddress(), regentAcct.address);
    return { regent, adapter, admin, regentAcct, voter, start };
  }

  it("constructor rejects zero addresses", async () => {
    const { regent, regentAcct } = await loadFixture(deployFixture);
    const Adapter = await ethers.getContractFactory("RegentVotesAdapter");
    await expect(Adapter.deploy(ethers.ZeroAddress, regentAcct.address)).to.be.revertedWithCustomError(Adapter, "ZeroAddress");
    await expect(Adapter.deploy(await regent.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(Adapter, "ZeroAddress");
  });

  it("uses EIP-6372 timestamp clock", async () => {
    const { adapter } = await loadFixture(deployFixture);
    expect(await adapter.CLOCK_MODE()).to.equal("mode=timestamp");
    const clk = await adapter.clock();
    expect(clk).to.be.closeTo(BigInt(await time.latest()), 5n);
  });

  it("getVotes: regent account carries weight, everyone else reads 0", async () => {
    const { adapter, regentAcct, voter } = await loadFixture(deployFixture);
    expect(await adapter.getVotes(regentAcct.address)).to.be.closeTo(INITIAL, INITIAL / 1000n);
    expect(await adapter.getVotes(voter.address)).to.equal(0n);
  });

  it("getPastVotes recomputes the decay curve from the schedule", async () => {
    const { adapter, regentAcct, start } = await loadFixture(deployFixture);
    // advance well past the midpoint so the midpoint is a valid PAST lookup
    await time.increaseTo(start + TWO_YEARS / 2 + 10);
    const mid = start + TWO_YEARS / 2;
    expect(await adapter.getPastVotes(regentAcct.address, mid)).to.equal(INITIAL / 2n);
    // quarter point
    const q = start + TWO_YEARS / 4;
    expect(await adapter.getPastVotes(regentAcct.address, q)).to.equal((INITIAL * 3n) / 4n);
  });

  it("PROVABLY returns 0 for any timepoint at/after schedule end", async () => {
    const { adapter, regentAcct, start } = await loadFixture(deployFixture);
    const end = start + TWO_YEARS;
    await time.increaseTo(end + 100);
    expect(await adapter.getPastVotes(regentAcct.address, end)).to.equal(0n);
    expect(await adapter.getPastVotes(regentAcct.address, end + 50)).to.equal(0n);
    expect(await adapter.getVotes(regentAcct.address)).to.equal(0n);
    expect(await adapter.getPastTotalSupply(end)).to.equal(0n);
  });

  it("getPastTotalSupply equals the regent weight at the timepoint", async () => {
    const { adapter, start } = await loadFixture(deployFixture);
    await time.increaseTo(start + TWO_YEARS / 2 + 10);
    const mid = start + TWO_YEARS / 2;
    expect(await adapter.getPastTotalSupply(mid)).to.equal(INITIAL / 2n);
  });

  it("future-timepoint lookups revert (mirrors OZ Votes semantics)", async () => {
    const { adapter, regentAcct } = await loadFixture(deployFixture);
    const future = (await time.latest()) + 10_000;
    await expect(adapter.getPastVotes(regentAcct.address, future)).to.be.revertedWithCustomError(adapter, "FutureLookup");
    await expect(adapter.getPastTotalSupply(future)).to.be.revertedWithCustomError(adapter, "FutureLookup");
  });

  it("non-regent accounts read 0 for getPastVotes too", async () => {
    const { adapter, voter, start } = await loadFixture(deployFixture);
    await time.increaseTo(start + TWO_YEARS / 4 + 10);
    expect(await adapter.getPastVotes(voter.address, start + TWO_YEARS / 8)).to.equal(0n);
  });

  it("reflects early renouncement (weight goes to 0 live and historically)", async () => {
    const { regent, adapter, admin, regentAcct, start } = await loadFixture(deployFixture);
    await time.increaseTo(start + TWO_YEARS / 4 + 10);
    expect(await adapter.getVotes(regentAcct.address)).to.be.greaterThan(0n);
    await regent.connect(admin).renounce();
    expect(await adapter.getVotes(regentAcct.address)).to.equal(0n);
    expect(await adapter.getPastVotes(regentAcct.address, start + TWO_YEARS / 8)).to.equal(0n);
  });

  it("delegation surface is inert", async () => {
    const { adapter, regentAcct } = await loadFixture(deployFixture);
    expect(await adapter.delegates(regentAcct.address)).to.equal(regentAcct.address);
    await expect(adapter.delegate(regentAcct.address)).to.be.revertedWith("regent: no delegation");
    await expect(
      adapter.delegateBySig(regentAcct.address, 0, 0, 0, ethers.ZeroHash, ethers.ZeroHash)
    ).to.be.revertedWith("regent: no delegation");
  });
});
