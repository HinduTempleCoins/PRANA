const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

describe("InterestRateModel (jump-rate)", function () {
  let irm;
  // base 0, slope1 = 2% (0.02e18), slope2 = 100% (1e18), kink at 80%
  const BASE = 0n;
  const SLOPE1 = WAD / 50n;   // 0.02e18
  const SLOPE2 = WAD;         // 1e18
  const KINK = (WAD * 8n) / 10n; // 0.8e18

  beforeEach(async () => {
    const IRM = await ethers.getContractFactory("InterestRateModel");
    irm = await IRM.deploy(BASE, SLOPE1, SLOPE2, KINK);
  });

  it("computes utilization", async () => {
    expect(await irm.utilization(0n, 0n)).to.equal(0n);
    expect(await irm.utilization(100n, 100n)).to.equal(WAD / 2n); // 50%
    expect(await irm.utilization(0n, 100n)).to.equal(WAD);        // 100%
  });

  it("is linear below the kink", async () => {
    // u = 50% -> rate = 0.5 * 0.02 = 0.01e18
    expect(await irm.borrowRate(100n, 100n)).to.equal(WAD / 100n);
  });

  it("jumps above the kink", async () => {
    // u = 100%: atKink = 0.8*0.02 = 0.016e18; + (0.2)*1 = 0.2e18 -> 0.216e18
    const expected = (KINK * SLOPE1) / WAD + ((WAD - KINK) * SLOPE2) / WAD;
    expect(await irm.borrowRate(0n, 100n)).to.equal(expected);
  });
});
