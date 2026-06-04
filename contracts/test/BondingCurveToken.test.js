const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

// price(k) = BASE + SLOPE*k  (reserve units per whole curve-token)
const BASE = WAD; // first token costs 1 reserve
const SLOPE = WAD / 10n; // each subsequent token costs 0.1 reserve more

// Cost of minting `n` tokens that occupy supply positions [start, start+n).
function segmentCost(start, n) {
  const indexSum = start * n + (n * (n - 1n)) / 2n;
  return n * BASE + SLOPE * indexSum;
}

describe("BondingCurveToken (linear bonding curve)", function () {
  let reserve, curve, deployer, user;

  beforeEach(async () => {
    [deployer, user] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    reserve = await Mock.deploy("Reserve", "RSV");

    const Curve = await ethers.getContractFactory("BondingCurveToken");
    curve = await Curve.deploy("Curve", "CRV", await reserve.getAddress(), BASE, SLOPE);

    // Fund the user with plenty of reserve and approve the curve.
    await reserve.mint(user.address, 1_000_000n * WAD);
    await reserve.connect(user).approve(await curve.getAddress(), ethers.MaxUint256);
  });

  it("costToMint increases with supply (and matches the closed form)", async () => {
    // From an empty supply, the first 10 tokens cost segmentCost(0, 10).
    expect(await curve.costToMint(10n)).to.equal(segmentCost(0n, 10n));

    // Buy some, advancing the curve, then the SAME quantity must cost strictly more.
    const firstBatch = await curve.costToMint(10n);
    await curve.connect(user).buy(10n, ethers.MaxUint256);

    const secondBatch = await curve.costToMint(10n);
    expect(secondBatch).to.equal(segmentCost(10n, 10n));
    expect(secondBatch).to.be.greaterThan(firstBatch);
  });

  it("buy mints tokens and pulls exactly the curve cost in reserve", async () => {
    const n = 25n;
    const cost = await curve.costToMint(n);
    expect(cost).to.equal(segmentCost(0n, n));

    const curveAddr = await curve.getAddress();
    const before = await reserve.balanceOf(user.address);

    await expect(curve.connect(user).buy(n, ethers.MaxUint256)).to.changeTokenBalance(
      curve,
      user,
      n
    );

    expect(before - (await reserve.balanceOf(user.address))).to.equal(cost);
    expect(await reserve.balanceOf(curveAddr)).to.equal(cost);
    expect(await curve.totalSupply()).to.equal(n);
  });

  it("buy reverts when the cost exceeds the reserve cap", async () => {
    const n = 5n;
    const cost = await curve.costToMint(n);
    await expect(
      curve.connect(user).buy(n, cost - 1n)
    ).to.be.revertedWithCustomError(curve, "ReserveCapExceeded");
  });

  it("sell burns tokens and returns reserve along the curve", async () => {
    await curve.connect(user).buy(40n, ethers.MaxUint256);

    const refund = await curve.refundOnBurn(15n);
    // selling the top 15 tokens refunds the cost of supply positions [25, 40).
    expect(refund).to.equal(segmentCost(25n, 15n));

    const before = await reserve.balanceOf(user.address);
    await expect(curve.connect(user).sell(15n, 0n)).to.changeTokenBalance(
      curve,
      user,
      -15n
    );

    expect((await reserve.balanceOf(user.address)) - before).to.equal(refund);
    expect(await curve.totalSupply()).to.equal(25n);
  });

  it("sell reverts when selling more than the balance", async () => {
    await curve.connect(user).buy(10n, ethers.MaxUint256);
    await expect(
      curve.connect(user).sell(11n, 0n)
    ).to.be.revertedWithCustomError(curve, "InsufficientBalance");
  });

  it("round-trips leave no free reserve in the contract (within rounding)", async () => {
    const curveAddr = await curve.getAddress();

    // A sequence of buys to grow supply, interleaved.
    await curve.connect(user).buy(30n, ethers.MaxUint256);
    await curve.connect(user).buy(20n, ethers.MaxUint256);
    expect(await curve.totalSupply()).to.equal(50n);

    // Sell everything back.
    await curve.connect(user).sell(50n, 0n);

    expect(await curve.totalSupply()).to.equal(0n);
    // Curve started empty and supply returned to 0 -> reserve must be fully drained.
    expect(await reserve.balanceOf(curveAddr)).to.equal(0n);
  });
});
