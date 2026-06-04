const { expect } = require("chai");
const { ethers } = require("hardhat");

// Far-future deadline so the router's `ensure` modifier never trips during tests.
const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;
const MINIMUM_LIQUIDITY = 1000n;

// expected LP for the first deposit = sqrt(a*b) - MINIMUM_LIQUIDITY
function isqrt(value) {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

describe("Uniswap V2 fork (AMM)", function () {
  let factory, router, tokenA, tokenB, token0, token1, pair;
  let deployer, lp, trader;

  const AMOUNT_A = ethers.parseEther("10000"); // liquidity for tokenA
  const AMOUNT_B = ethers.parseEther("40000"); // liquidity for tokenB

  beforeEach(async () => {
    [deployer, lp, trader] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    tokenA = await Mock.deploy("Token A", "TKA");
    tokenB = await Mock.deploy("Token B", "TKB");

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    factory = await Factory.deploy(deployer.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    router = await Router.deploy(await factory.getAddress());

    // Fund the LP and approve the router.
    await tokenA.mint(lp.address, AMOUNT_A);
    await tokenB.mint(lp.address, AMOUNT_B);
    await tokenA.connect(lp).approve(await router.getAddress(), MAX);
    await tokenB.connect(lp).approve(await router.getAddress(), MAX);
  });

  it("creates a pair through the factory with deterministic sorted tokens", async () => {
    await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
    expect(await factory.allPairsLength()).to.equal(1n);

    const pairAddr = await factory.getPair(
      await tokenA.getAddress(),
      await tokenB.getAddress()
    );
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);
    // reverse lookup populated too
    expect(
      await factory.getPair(await tokenB.getAddress(), await tokenA.getAddress())
    ).to.equal(pairAddr);

    pair = await ethers.getContractAt("UniswapV2Pair", pairAddr);
    const t0 = await pair.token0();
    const t1 = await pair.token1();
    expect(BigInt(t0)).to.be.lessThan(BigInt(t1)); // token0 < token1
  });

  it("reverts on identical-token pair creation", async () => {
    await expect(
      factory.createPair(await tokenA.getAddress(), await tokenA.getAddress())
    ).to.be.revertedWith("UniswapV2: IDENTICAL_ADDRESSES");
  });

  async function addInitialLiquidity() {
    await router
      .connect(lp)
      .addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        AMOUNT_A,
        AMOUNT_B,
        0n,
        0n,
        lp.address,
        DEADLINE
      );
    const pairAddr = await factory.getPair(
      await tokenA.getAddress(),
      await tokenB.getAddress()
    );
    pair = await ethers.getContractAt("UniswapV2Pair", pairAddr);
  }

  it("adds liquidity: mints LP (minus MINIMUM_LIQUIDITY) and sets reserves", async () => {
    await addInitialLiquidity();

    const expectedLP = isqrt(AMOUNT_A * AMOUNT_B) - MINIMUM_LIQUIDITY;
    expect(await pair.balanceOf(lp.address)).to.equal(expectedLP);
    // MINIMUM_LIQUIDITY permanently locked at the zero address
    expect(await pair.balanceOf(ethers.ZeroAddress)).to.equal(MINIMUM_LIQUIDITY);
    expect(await pair.totalSupply()).to.equal(expectedLP + MINIMUM_LIQUIDITY);

    // reserves match deposited amounts (mapped to sorted token0/token1)
    const [r0, r1] = await pair.getReserves();
    const token0Addr = await pair.token0();
    const aIs0 = (await tokenA.getAddress()) === token0Addr;
    const reserveA = aIs0 ? r0 : r1;
    const reserveB = aIs0 ? r1 : r0;
    expect(reserveA).to.equal(AMOUNT_A);
    expect(reserveB).to.equal(AMOUNT_B);
  });

  it("swaps exact input across the pair; x*y=k holds and k grows from fees", async () => {
    await addInitialLiquidity();

    const [r0Before, r1Before] = await pair.getReserves();
    const kBefore = r0Before * r1Before;

    const amountIn = ethers.parseEther("1000");
    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), MAX);

    const path = [await tokenA.getAddress(), await tokenB.getAddress()];

    // Predicted output from the library matches what the trader receives.
    const amounts = await router.getAmountsOut(amountIn, path);
    const predictedOut = amounts[1];

    const balBefore = await tokenB.balanceOf(trader.address);
    await router
      .connect(trader)
      .swapExactTokensForTokens(amountIn, 0n, path, trader.address, DEADLINE);
    const received = (await tokenB.balanceOf(trader.address)) - balBefore;

    expect(received).to.equal(predictedOut);
    expect(received).to.be.greaterThan(0n);

    const [r0After, r1After] = await pair.getReserves();
    const kAfter = r0After * r1After;

    // The constant-product invariant must not decrease, and the 0.3% fee makes k grow.
    expect(kAfter).to.be.greaterThan(kBefore);
  });

  it("removeLiquidity returns both tokens to the LP and burns LP supply", async () => {
    await addInitialLiquidity();

    const lpBal = await pair.balanceOf(lp.address);
    await pair.connect(lp).approve(await router.getAddress(), MAX);

    const aBefore = await tokenA.balanceOf(lp.address);
    const bBefore = await tokenB.balanceOf(lp.address);

    await router
      .connect(lp)
      .removeLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        lpBal,
        0n,
        0n,
        lp.address,
        DEADLINE
      );

    const aReturned = (await tokenA.balanceOf(lp.address)) - aBefore;
    const bReturned = (await tokenB.balanceOf(lp.address)) - bBefore;

    expect(aReturned).to.be.greaterThan(0n);
    expect(bReturned).to.be.greaterThan(0n);
    expect(await pair.balanceOf(lp.address)).to.equal(0n);
    // only the permanently-locked MINIMUM_LIQUIDITY remains
    expect(await pair.totalSupply()).to.equal(MINIMUM_LIQUIDITY);
  });
});
