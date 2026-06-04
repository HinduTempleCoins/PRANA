const { expect } = require("chai");
const { ethers } = require("hardhat");

const FEE_BPS = 30n; // 0.30%
const BPS = 10_000n;

describe("PeggedSwapPool (constant-sum 1:1 AMM)", function () {
  let token0, token1, pool, lp, trader;

  beforeEach(async () => {
    [lp, trader] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token0 = await Mock.deploy("Pegged A", "PEGA");
    token1 = await Mock.deploy("Pegged B", "PEGB");

    const Pool = await ethers.getContractFactory("PeggedSwapPool");
    pool = await Pool.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      FEE_BPS
    );

    // Seed the LP with both tokens and approve the pool.
    await token0.mint(lp.address, 1_000_000n);
    await token1.mint(lp.address, 1_000_000n);
    await token0.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await token1.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  it("adds liquidity and mints shares = amount0 + amount1", async () => {
    await pool.connect(lp).addLiquidity(10_000n, 20_000n);

    expect(await pool.reserve0()).to.equal(10_000n);
    expect(await pool.reserve1()).to.equal(20_000n);
    expect(await pool.totalShares()).to.equal(30_000n);
    expect(await pool.shares(lp.address)).to.equal(30_000n);
    expect(await token0.balanceOf(await pool.getAddress())).to.equal(10_000n);
    expect(await token1.balanceOf(await pool.getAddress())).to.equal(20_000n);
  });

  it("swap0for1 pays out amountIn minus fee, 1:1", async () => {
    await pool.connect(lp).addLiquidity(50_000n, 50_000n);

    await token0.mint(trader.address, 10_000n);
    await token0.connect(trader).approve(await pool.getAddress(), 10_000n);

    const amountIn = 10_000n;
    const fee = (amountIn * FEE_BPS) / BPS; // 30
    const expectedOut = amountIn - fee; // 9970

    await pool.connect(trader).swap0for1(amountIn);

    expect(await token1.balanceOf(trader.address)).to.equal(expectedOut);
    // token0 reserve grew by full input; token1 reserve shrank by output.
    expect(await pool.reserve0()).to.equal(50_000n + amountIn);
    expect(await pool.reserve1()).to.equal(50_000n - expectedOut);
  });

  it("swap1for0 works symmetrically", async () => {
    await pool.connect(lp).addLiquidity(50_000n, 50_000n);

    await token1.mint(trader.address, 5_000n);
    await token1.connect(trader).approve(await pool.getAddress(), 5_000n);

    const amountIn = 5_000n;
    const expectedOut = amountIn - (amountIn * FEE_BPS) / BPS; // 4985

    await pool.connect(trader).swap1for0(amountIn);
    expect(await token0.balanceOf(trader.address)).to.equal(expectedOut);
  });

  it("reverts when the output reserve is too low", async () => {
    // Only 100 token1 in reserve; trader tries to pull more out.
    await pool.connect(lp).addLiquidity(100_000n, 100n);

    await token0.mint(trader.address, 10_000n);
    await token0.connect(trader).approve(await pool.getAddress(), 10_000n);

    await expect(
      pool.connect(trader).swap0for1(10_000n)
    ).to.be.revertedWith("insufficient reserve");
  });

  it("removeLiquidity returns proportional reserves including accrued fees", async () => {
    await pool.connect(lp).addLiquidity(50_000n, 50_000n);

    // Trader swaps, leaving a fee behind in the pool.
    await token0.mint(trader.address, 10_000n);
    await token0.connect(trader).approve(await pool.getAddress(), 10_000n);
    await pool.connect(trader).swap0for1(10_000n);

    // Sole LP holds all shares -> withdraws the entire reserve, fee included.
    const r0 = await pool.reserve0(); // 60_000
    const r1 = await pool.reserve1(); // 40_030
    const totalReserves = r0 + r1; // 100_030 > 100_000 deposited -> fee accrued

    expect(totalReserves).to.be.greaterThan(100_000n);

    const before0 = await token0.balanceOf(lp.address);
    const before1 = await token1.balanceOf(lp.address);

    await pool.connect(lp).removeLiquidity(await pool.shares(lp.address));

    expect((await token0.balanceOf(lp.address)) - before0).to.equal(r0);
    expect((await token1.balanceOf(lp.address)) - before1).to.equal(r1);
    expect(await pool.totalShares()).to.equal(0n);
    expect(await pool.reserve0()).to.equal(0n);
    expect(await pool.reserve1()).to.equal(0n);
  });

  it("rejects zero-amount swaps and burning more shares than owned", async () => {
    await pool.connect(lp).addLiquidity(10_000n, 10_000n);
    await expect(pool.connect(lp).swap0for1(0n)).to.be.revertedWith("zero input");
    await expect(
      pool.connect(lp).removeLiquidity(20_001n)
    ).to.be.revertedWith("insufficient shares");
  });
});
