const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;

// Canonical V2 math, mirrored in JS for cross-checking the on-chain library.
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}
function getAmountIn(amountOut, reserveIn, reserveOut) {
  const numerator = reserveIn * amountOut * 1000n;
  const denominator = (reserveOut - amountOut) * 997n;
  return numerator / denominator + 1n;
}
function quote(amountA, reserveA, reserveB) {
  return (amountA * reserveB) / reserveA;
}

describe("AMM library quoting math (against live pairs)", function () {
  // Three tokens so we can build a 2-hop path A -> B -> C.
  async function fixture() {
    const [deployer, lp, trader] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const tokenA = await Mock.deploy("Token A", "TKA");
    const tokenB = await Mock.deploy("Token B", "TKB");
    const tokenC = await Mock.deploy("Token C", "TKC");

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(deployer.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    const router = await Router.deploy(await factory.getAddress());

    const routerAddr = await router.getAddress();

    // Reserves: A/B = 10000/40000, B/C = 50000/20000
    const RA = ethers.parseEther("10000");
    const RB1 = ethers.parseEther("40000");
    const RB2 = ethers.parseEther("50000");
    const RC = ethers.parseEther("20000");

    for (const [t, amt] of [
      [tokenA, RA],
      [tokenB, RB1 + RB2],
      [tokenC, RC],
    ]) {
      await t.mint(lp.address, amt);
      await t.connect(lp).approve(routerAddr, MAX);
    }

    await router
      .connect(lp)
      .addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        RA,
        RB1,
        0n,
        0n,
        lp.address,
        DEADLINE
      );
    await router
      .connect(lp)
      .addLiquidity(
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        RB2,
        RC,
        0n,
        0n,
        lp.address,
        DEADLINE
      );

    return { factory, router, tokenA, tokenB, tokenC, deployer, lp, trader, RA, RB1, RB2, RC };
  }

  it("getAmountOut matches canonical math and applies the 0.3% fee", async () => {
    const { router } = await loadFixture(fixture);
    const rIn = ethers.parseEther("10000");
    const rOut = ethers.parseEther("40000");
    const amountIn = ethers.parseEther("1000");

    const out = await router.getAmountOut(amountIn, rIn, rOut);
    expect(out).to.equal(getAmountOut(amountIn, rIn, rOut));
    // strictly less than the fee-free constant-product quote
    expect(out).to.be.lessThan(quote(amountIn, rIn, rOut));
  });

  it("getAmountOut/getAmountIn round-trip: feeding the required input yields at least the target output", async () => {
    const { router } = await loadFixture(fixture);
    const rIn = ethers.parseEther("10000");
    const rOut = ethers.parseEther("40000");
    const targetOut = ethers.parseEther("500");

    const needIn = await router.getAmountIn(targetOut, rIn, rOut);
    const gotOut = await router.getAmountOut(needIn, rIn, rOut);
    // getAmountIn rounds up (+1), so re-deriving the output must meet or slightly exceed target.
    expect(gotOut).to.be.greaterThanOrEqual(targetOut);
    // and it must not overshoot by more than one extra unit of slack
    expect(gotOut - targetOut).to.be.lessThan(ethers.parseEther("0.001"));
    expect(needIn).to.equal(getAmountIn(targetOut, rIn, rOut));
  });

  it("quote() is proportional: doubling amountA doubles amountB", async () => {
    const { router } = await loadFixture(fixture);
    const rA = ethers.parseEther("10000");
    const rB = ethers.parseEther("40000");
    const q1 = await router.quote(ethers.parseEther("100"), rA, rB);
    const q2 = await router.quote(ethers.parseEther("200"), rA, rB);
    expect(q2).to.equal(q1 * 2n);
    expect(q1).to.equal(quote(ethers.parseEther("100"), rA, rB));
  });

  it("getAmountsOut composes per-hop pricing across a 2-hop path A->B->C", async () => {
    const { factory, router, tokenA, tokenB, tokenC } = await loadFixture(fixture);
    const amountIn = ethers.parseEther("1000");
    const path = [
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      await tokenC.getAddress(),
    ];
    const amounts = await router.getAmountsOut(amountIn, path);
    expect(amounts.length).to.equal(3);
    expect(amounts[0]).to.equal(amountIn);

    // Recompute hop 1 (A/B reserves) then hop 2 (B/C reserves) and compare.
    const pairAB = await ethers.getContractAt(
      "UniswapV2Pair",
      await factory.getPair(path[0], path[1])
    );
    const [ra0, ra1] = await pairAB.getReserves();
    const aIs0 = BigInt(path[0]) < BigInt(path[1]); // map sorted -> (in, out) for path[0]->path[1]
    const out1 = getAmountOut(amountIn, aIs0 ? ra0 : ra1, aIs0 ? ra1 : ra0);
    expect(amounts[1]).to.equal(out1);

    const pairBC = await ethers.getContractAt(
      "UniswapV2Pair",
      await factory.getPair(path[1], path[2])
    );
    const [rb0, rb1] = await pairBC.getReserves();
    const bIs0 = BigInt(path[1]) < BigInt(path[2]);
    const out2 = getAmountOut(out1, bIs0 ? rb0 : rb1, bIs0 ? rb1 : rb0);
    expect(amounts[2]).to.equal(out2);
  });

  it("a real multi-hop swap delivers exactly getAmountsOut's last element", async () => {
    const { router, tokenA, tokenB, tokenC, trader } = await loadFixture(fixture);
    const amountIn = ethers.parseEther("1000");
    const path = [
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      await tokenC.getAddress(),
    ];
    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), MAX);

    const amounts = await router.getAmountsOut(amountIn, path);
    const before = await tokenC.balanceOf(trader.address);
    await router
      .connect(trader)
      .swapExactTokensForTokens(amountIn, 0n, path, trader.address, DEADLINE);
    const received = (await tokenC.balanceOf(trader.address)) - before;
    expect(received).to.equal(amounts[2]);
  });

  describe("edge cases", function () {
    it("getAmountOut reverts on zero input", async () => {
      const { router } = await loadFixture(fixture);
      await expect(
        router.getAmountOut(0n, ethers.parseEther("1"), ethers.parseEther("1"))
      ).to.be.revertedWith("UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT");
    });

    it("getAmountOut reverts on zero liquidity", async () => {
      const { router } = await loadFixture(fixture);
      await expect(
        router.getAmountOut(1n, 0n, ethers.parseEther("1"))
      ).to.be.revertedWith("UniswapV2Library: INSUFFICIENT_LIQUIDITY");
    });

    it("getAmountIn reverts on zero output", async () => {
      const { router } = await loadFixture(fixture);
      await expect(
        router.getAmountIn(0n, ethers.parseEther("1"), ethers.parseEther("1"))
      ).to.be.revertedWith("UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
    });

    it("quote reverts on zero amount and on zero liquidity", async () => {
      const { router } = await loadFixture(fixture);
      await expect(
        router.quote(0n, ethers.parseEther("1"), ethers.parseEther("1"))
      ).to.be.revertedWith("UniswapV2Library: INSUFFICIENT_AMOUNT");
      await expect(
        router.quote(1n, 0n, ethers.parseEther("1"))
      ).to.be.revertedWith("UniswapV2Library: INSUFFICIENT_LIQUIDITY");
    });

    it("getAmountsOut reverts when the path has no pair / insufficient liquidity", async () => {
      const { router, tokenA, tokenC } = await loadFixture(fixture);
      // A/C pair was never created -> pairFor reverts PAIR_NOT_FOUND inside getReserves.
      const path = [await tokenA.getAddress(), await tokenC.getAddress()];
      await expect(
        router.getAmountsOut(ethers.parseEther("1"), path)
      ).to.be.revertedWith("UniswapV2Library: PAIR_NOT_FOUND");
    });

    it("getAmountsOut reverts on a too-short path", async () => {
      const { router, tokenA } = await loadFixture(fixture);
      await expect(
        router.getAmountsOut(1n, [await tokenA.getAddress()])
      ).to.be.revertedWith("UniswapV2Router: INVALID_PATH");
    });
  });
});
