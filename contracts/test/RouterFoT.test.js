const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;
const FEE_BPS = 100n; // 1% fee-on-transfer token

describe("UniswapV2RouterFoT — fee-on-transfer-safe swaps", function () {
  // Pair: FOT (fee-on-transfer) <-> NORM (standard). LP seeds liquidity, trader swaps FOT->NORM.
  async function fixture() {
    const [deployer, lp, trader] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const Fot = await ethers.getContractFactory("FeeOnTransferToken");

    const norm = await Mock.deploy("Normal", "NRM");
    const fot = await Fot.deploy("FeeTok", "FOT", FEE_BPS);

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(deployer.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    const router = await Router.deploy(await factory.getAddress());

    const RouterFoT = await ethers.getContractFactory("UniswapV2RouterFoT");
    const routerFoT = await RouterFoT.deploy(await factory.getAddress());

    // Seed liquidity. The router pulls FOT from the LP -> the pair receives less than sent,
    // but that's fine: the pair's first mint reads its own balances.
    const fotLiq = ethers.parseEther("100000");
    const normLiq = ethers.parseEther("100000");
    await fot.mint(lp.address, fotLiq);
    await norm.mint(lp.address, normLiq);
    await fot.connect(lp).approve(await router.getAddress(), MAX);
    await norm.connect(lp).approve(await router.getAddress(), MAX);

    await router
      .connect(lp)
      .addLiquidity(
        await fot.getAddress(),
        await norm.getAddress(),
        fotLiq,
        normLiq,
        0n,
        0n,
        lp.address,
        DEADLINE
      );

    const pairAddr = await factory.getPair(
      await fot.getAddress(),
      await norm.getAddress()
    );
    const pair = await ethers.getContractAt("UniswapV2Pair", pairAddr);

    return { factory, router, routerFoT, fot, norm, pair, deployer, lp, trader };
  }

  it("the PLAIN router reverts when swapping a fee-on-transfer input token", async () => {
    const { router, fot, norm, trader } = await loadFixture(fixture);
    const amountIn = ethers.parseEther("1000");
    await fot.mint(trader.address, amountIn);
    await fot.connect(trader).approve(await router.getAddress(), MAX);

    const path = [await fot.getAddress(), await norm.getAddress()];
    // Plain router computes amounts off `amountIn`, but only amountIn*(1-fee) actually reaches
    // the pair -> the K check in swap() fails -> revert.
    await expect(
      router
        .connect(trader)
        .swapExactTokensForTokens(amountIn, 0n, path, trader.address, DEADLINE)
    ).to.be.revertedWith("UniswapV2: K");
  });

  it("the FoT router succeeds and the trader receives a positive NORM amount", async () => {
    const { routerFoT, fot, norm, trader } = await loadFixture(fixture);
    const amountIn = ethers.parseEther("1000");
    await fot.mint(trader.address, amountIn);
    await fot.connect(trader).approve(await routerFoT.getAddress(), MAX);

    const path = [await fot.getAddress(), await norm.getAddress()];
    const before = await norm.balanceOf(trader.address);

    await expect(
      routerFoT
        .connect(trader)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          0n,
          path,
          trader.address,
          DEADLINE
        )
    ).to.not.be.reverted;

    const received = (await norm.balanceOf(trader.address)) - before;
    expect(received).to.be.greaterThan(0n);
  });

  it("enforces amountOutMin against the actual received balance delta", async () => {
    const { routerFoT, fot, norm, trader } = await loadFixture(fixture);
    const amountIn = ethers.parseEther("1000");
    await fot.mint(trader.address, amountIn);
    await fot.connect(trader).approve(await routerFoT.getAddress(), MAX);

    const path = [await fot.getAddress(), await norm.getAddress()];
    // Demand far more output than possible -> must revert on the output-delta check.
    await expect(
      routerFoT
        .connect(trader)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          ethers.parseEther("100000"),
          path,
          trader.address,
          DEADLINE
        )
    ).to.be.revertedWith("UniswapV2RouterFoT: INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("reverts on an expired deadline", async () => {
    const { routerFoT, fot, norm, trader } = await loadFixture(fixture);
    const path = [await fot.getAddress(), await norm.getAddress()];
    await expect(
      routerFoT
        .connect(trader)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          1n,
          0n,
          path,
          trader.address,
          1n // long-past deadline
        )
    ).to.be.revertedWith("UniswapV2RouterFoT: EXPIRED");
  });

  it("reverts on an invalid (single-token) path", async () => {
    const { routerFoT, fot, trader } = await loadFixture(fixture);
    await expect(
      routerFoT
        .connect(trader)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          1n,
          0n,
          [await fot.getAddress()],
          trader.address,
          DEADLINE
        )
    ).to.be.revertedWith("UniswapV2RouterFoT: INVALID_PATH");
  });
});
