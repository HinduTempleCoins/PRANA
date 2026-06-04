const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TWAPOracle", function () {
  let oracle, updater, other;

  beforeEach(async function () {
    [updater, other] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("TWAPOracle");
    oracle = await Oracle.connect(updater).deploy(updater.address);
    await oracle.waitForDeployment();
  });

  it("only the updater can call update", async function () {
    await expect(oracle.connect(other).update(100n))
      .to.be.revertedWithCustomError(oracle, "NotUpdater");
    await expect(oracle.connect(updater).update(100n)).to.not.be.reverted;
  });

  it("accumulates price weighted by elapsed time", async function () {
    // Set standing price to 100.
    await oracle.connect(updater).update(100n);
    const t0 = await oracle.lastUpdate();
    const c0 = await oracle.priceCumulative();

    // Hold 100 for 1000s, then update to 200.
    await time.increase(1000);
    await oracle.connect(updater).update(200n);

    const c1 = await oracle.priceCumulative();
    // ~100 * 1000 accumulated (allow tiny band for the extra ~1s per tx).
    const delta = c1 - c0;
    expect(delta).to.be.greaterThanOrEqual(100n * 1000n);
    expect(delta).to.be.lessThanOrEqual(100n * 1005n);

    expect(await oracle.lastUpdate()).to.be.greaterThan(t0);
  });

  it("consult returns the correct time-weighted average across snapshots", async function () {
    // Standing price 100.
    await oracle.connect(updater).update(100n);

    // Snapshot here.
    const sinceTs = await oracle.lastUpdate();
    const sinceCum = await oracle.priceCumulative();

    // Hold 100 for 1000s -> update to 300.
    await time.increase(1000);
    await oracle.connect(updater).update(300n);

    // Hold 300 for 1000s -> update (price value irrelevant, just to seal window).
    await time.increase(1000);
    await oracle.connect(updater).update(300n);

    // Window ~2000s: 100 for ~1000s + 300 for ~1000s => TWAP ~200.
    const twap = await oracle.consult(sinceTs, sinceCum);
    expect(twap).to.be.greaterThanOrEqual(199n);
    expect(twap).to.be.lessThanOrEqual(201n);
  });

  it("a brief price spike has limited weight (manipulation resistance)", async function () {
    await oracle.connect(updater).update(100n);
    const sinceTs = await oracle.lastUpdate();
    const sinceCum = await oracle.priceCumulative();

    // 100 held for a long time.
    await time.increase(10000);
    await oracle.connect(updater).update(1000000n); // spike

    // Spike held only briefly.
    await time.increase(1);
    await oracle.connect(updater).update(100n);

    // TWAP should stay near 100 despite the huge momentary spike.
    const twap = await oracle.consult(sinceTs, sinceCum);
    expect(twap).to.be.lessThan(1000n);
  });

  it("consult reverts when no time has elapsed since the snapshot", async function () {
    await oracle.connect(updater).update(100n);
    const sinceTs = await oracle.lastUpdate();
    const sinceCum = await oracle.priceCumulative();

    // Same lastUpdate, no further update => window is zero.
    await expect(oracle.consult(sinceTs, sinceCum))
      .to.be.revertedWithCustomError(oracle, "NoTimeElapsed");
  });
});
