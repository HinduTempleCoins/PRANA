const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const A = 100n; // amplification (raw)
const FEE_BPS = 4n; // 0.04% imbalance/swap fee
const E18 = 10n ** 18n;

describe("StableSwapPool (Curve-style two-token invariant pool)", function () {
  async function deployFixture() {
    const [admin, lp, lp2, trader] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const token0 = await Mock.deploy("Pegged A", "PEGA");
    const token1 = await Mock.deploy("Pegged B", "PEGB");

    const Pool = await ethers.getContractFactory("StableSwapPool");
    const pool = await Pool.deploy(
      "Stable LP",
      "sLP",
      await token0.getAddress(),
      await token1.getAddress(),
      A,
      FEE_BPS,
      admin.address
    );

    const poolAddr = await pool.getAddress();
    for (const who of [lp, lp2, trader]) {
      await token0.mint(who.address, 10_000_000n * E18);
      await token1.mint(who.address, 10_000_000n * E18);
      await token0.connect(who).approve(poolAddr, ethers.MaxUint256);
      await token1.connect(who).approve(poolAddr, ethers.MaxUint256);
    }
    return { pool, token0, token1, admin, lp, lp2, trader, poolAddr };
  }

  async function seeded() {
    const f = await deployFixture();
    // balanced 1M : 1M seed
    await f.pool.connect(f.lp).addLiquidity(1_000_000n * E18, 1_000_000n * E18, 0);
    return f;
  }

  it("first deposit mints LP = D and sets reserves", async () => {
    const { pool, lp } = await loadFixture(deployFixture);
    await pool.connect(lp).addLiquidity(1_000_000n * E18, 1_000_000n * E18, 0);
    // For a perfectly balanced pool D == sum of balances.
    const d = await pool.getD();
    expect(d).to.equal(2_000_000n * E18);
    expect(await pool.totalSupply()).to.equal(d);
    expect(await pool.reserve0()).to.equal(1_000_000n * E18);
    expect(await pool.reserve1()).to.equal(1_000_000n * E18);
  });

  it("rejects single-sided first deposit", async () => {
    const { pool, lp } = await loadFixture(deployFixture);
    await expect(
      pool.connect(lp).addLiquidity(1_000_000n * E18, 0, 0)
    ).to.be.revertedWithCustomError(pool, "ImbalancedFirstDeposit");
  });

  it("D increases monotonically with deposits", async () => {
    const { pool, lp, lp2 } = await loadFixture(deployFixture);
    await pool.connect(lp).addLiquidity(1_000_000n * E18, 1_000_000n * E18, 0);
    const d1 = await pool.getD();
    await pool.connect(lp2).addLiquidity(500_000n * E18, 500_000n * E18, 0);
    const d2 = await pool.getD();
    expect(d2).to.be.gt(d1);
    // proportional add ~doubles+half → D grows ~1.5x
    expect(d2).to.equal(3_000_000n * E18);
  });

  it("Newton converges on a heavily skewed pool (getD/getY don't revert)", async () => {
    const { pool, lp } = await loadFixture(deployFixture);
    // 100 : 1_000_000 — extreme imbalance
    await pool.connect(lp).addLiquidity(100n * E18, 1_000_000n * E18, 0);
    const d = await pool.getD();
    expect(d).to.be.gt(0n);
    // a quote on the skewed pool must also resolve
    const dy = await pool.getDy(0, 1, 10n * E18);
    expect(dy).to.be.gt(0n);
  });

  it("swap near peg gives dy/dx ≈ 1 (within fee + tiny slippage)", async () => {
    const { pool } = await loadFixture(seeded);
    const dx = 1_000n * E18;
    const dy = await pool.getDy(0, 1, dx);
    // expect very close to 1:1; allow up to ~0.1% deviation incl 0.04% fee
    const ratio = (dy * 10_000n) / dx; // bps of dx
    expect(ratio).to.be.gt(9_980n);
    expect(ratio).to.be.lte(10_000n);
  });

  it("slippage grows as the trade imbalances the pool", async () => {
    const { pool } = await loadFixture(seeded);
    const small = await pool.getDy(0, 1, 1_000n * E18);
    const big = await pool.getDy(0, 1, 500_000n * E18);
    const smallRate = (small * E18) / (1_000n * E18);
    const bigRate = (big * E18) / (500_000n * E18);
    expect(bigRate).to.be.lt(smallRate); // worse price per unit on the larger trade
  });

  it("beats constant-product (x*y=k) for the same imbalanced trade", async () => {
    const { pool } = await loadFixture(seeded);
    const x = 1_000_000n * E18;
    const y = 1_000_000n * E18;
    const dx = 200_000n * E18;

    const ssOut = await pool.getDy(0, 1, dx);

    // x*y=k output with the SAME 0.04% fee applied to dx, integer math
    const dxAfterFee = dx - (dx * FEE_BPS) / 10_000n;
    const cpOut = (y * dxAfterFee) / (x + dxAfterFee);

    expect(ssOut).to.be.gt(cpOut); // StableSwap loses far less to slippage near peg
  });

  it("exchange transfers tokens, accrues fee to the pool, and respects minDy", async () => {
    const { pool, token0, token1, trader, poolAddr } = await loadFixture(seeded);
    const dx = 10_000n * E18;
    const quoted = await pool.getDy(0, 1, dx);

    const t1Before = await token1.balanceOf(trader.address);
    const poolD0 = await pool.getD();

    await expect(pool.connect(trader).exchange(0, 1, dx, quoted))
      .to.emit(pool, "TokenExchange");

    const t1After = await token1.balanceOf(trader.address);
    expect(t1After - t1Before).to.equal(quoted);

    // pool received full dx of token0
    expect(await token0.balanceOf(poolAddr)).to.equal(1_000_000n * E18 + dx);
    // fee stays in pool → D strictly increases
    expect(await pool.getD()).to.be.gt(poolD0);
  });

  it("exchange reverts when output below minDy", async () => {
    const { pool, trader } = await loadFixture(seeded);
    const dx = 10_000n * E18;
    const quoted = await pool.getDy(0, 1, dx);
    await expect(
      pool.connect(trader).exchange(0, 1, dx, quoted + 1n)
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });

  it("rejects invalid coin indices and zero amount", async () => {
    const { pool, trader } = await loadFixture(seeded);
    await expect(pool.connect(trader).exchange(0, 0, 1n, 0)).to.be.revertedWithCustomError(pool, "InvalidCoin");
    await expect(pool.connect(trader).exchange(0, 2, 1n, 0)).to.be.revertedWithCustomError(pool, "InvalidCoin");
    await expect(pool.connect(trader).exchange(0, 1, 0, 0)).to.be.revertedWithCustomError(pool, "ZeroAmount");
  });

  it("proportional remove_liquidity returns the deposited share", async () => {
    const { pool, token0, token1, lp } = await loadFixture(seeded);
    const lpBal = await pool.balanceOf(lp.address);
    const t0Before = await token0.balanceOf(lp.address);
    const t1Before = await token1.balanceOf(lp.address);

    await pool.connect(lp).removeLiquidity(lpBal / 2n, 0, 0);

    // half the balanced pool back
    expect((await token0.balanceOf(lp.address)) - t0Before).to.equal(500_000n * E18);
    expect((await token1.balanceOf(lp.address)) - t1Before).to.equal(500_000n * E18);
    expect(await pool.balanceOf(lp.address)).to.equal(lpBal / 2n);
  });

  it("remove_liquidity honors min amounts", async () => {
    const { pool, lp } = await loadFixture(seeded);
    const lpBal = await pool.balanceOf(lp.address);
    await expect(
      pool.connect(lp).removeLiquidity(lpBal / 2n, 600_000n * E18, 0)
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });

  it("remove_liquidity_one_coin pays out a single coin near its proportional value", async () => {
    const { pool, token0, lp } = await loadFixture(seeded);
    const lpBal = await pool.balanceOf(lp.address);
    const burn = lpBal / 100n; // 1%

    const quote = await pool.calcWithdrawOneCoin(burn, 0);
    const before = await token0.balanceOf(lp.address);
    await pool.connect(lp).removeLiquidityOneCoin(burn, 0, quote);
    const got = (await token0.balanceOf(lp.address)) - before;

    expect(got).to.equal(quote);
    // 1% of D in one coin from a balanced pool ≈ 20_000 (since D=2M, 1% = 20k) minus small imbalance fee
    expect(got).to.be.gt(19_000n * E18);
    expect(got).to.be.lt(20_001n * E18);
  });

  it("remove_liquidity_one_coin respects min", async () => {
    const { pool, lp } = await loadFixture(seeded);
    const lpBal = await pool.balanceOf(lp.address);
    const burn = lpBal / 100n;
    const quote = await pool.calcWithdrawOneCoin(burn, 0);
    await expect(
      pool.connect(lp).removeLiquidityOneCoin(burn, 0, quote + 1n)
    ).to.be.revertedWithCustomError(pool, "InsufficientOutput");
  });

  it("imbalanced add mints less LP than an equivalent proportional add (imbalance fee)", async () => {
    const f1 = await loadFixture(seeded);
    const f2 = await loadFixture(seeded);

    // proportional 100k:100k
    const beforeProp = await f1.pool.balanceOf(f1.lp2.address);
    await f1.pool.connect(f1.lp2).addLiquidity(100_000n * E18, 100_000n * E18, 0);
    const propMint = (await f1.pool.balanceOf(f1.lp2.address)) - beforeProp;

    // imbalanced 200k:0 (same total value 200k) → pays imbalance fee
    const beforeImb = await f2.pool.balanceOf(f2.lp2.address);
    await f2.pool.connect(f2.lp2).addLiquidity(200_000n * E18, 0, 0);
    const imbMint = (await f2.pool.balanceOf(f2.lp2.address)) - beforeImb;

    expect(imbMint).to.be.lt(propMint);
  });

  describe("amplification ramp", function () {
    it("ramps A linearly over time", async () => {
      const { pool, admin } = await loadFixture(seeded);
      expect(await pool.A()).to.equal(A);

      // first ramp must wait MIN_RAMP_TIME from deploy
      await time.increase(24 * 3600 + 1);
      const start = await time.latest();
      const end = start + 10 * 24 * 3600; // 10 days
      await pool.connect(admin).rampA(1000n, end);

      // midway ~ between 100 and 1000
      await time.increaseTo(start + 5 * 24 * 3600);
      const mid = await pool.A();
      expect(mid).to.be.gt(A);
      expect(mid).to.be.lt(1000n);

      // after end → exactly target
      await time.increaseTo(end + 10);
      expect(await pool.A()).to.equal(1000n);
    });

    it("rejects ramp that is too soon or too fast", async () => {
      const { pool, admin } = await loadFixture(seeded);
      await time.increase(24 * 3600 + 1);
      const start = await time.latest();
      // too soon: end < now + MIN_RAMP_TIME
      await expect(
        pool.connect(admin).rampA(200n, start + 10)
      ).to.be.revertedWithCustomError(pool, "RampTooSoon");
      // too fast: >10x
      await expect(
        pool.connect(admin).rampA(2000n, start + 30 * 24 * 3600)
      ).to.be.revertedWithCustomError(pool, "RampTooFast");
    });

    it("stopRampA freezes A at the interpolated value", async () => {
      const { pool, admin } = await loadFixture(seeded);
      await time.increase(24 * 3600 + 1);
      const start = await time.latest();
      const end = start + 10 * 24 * 3600;
      await pool.connect(admin).rampA(1000n, end);
      await time.increaseTo(start + 5 * 24 * 3600);
      await pool.connect(admin).stopRampA();
      const frozen = await pool.A();
      await time.increaseTo(end + 1000);
      expect(await pool.A()).to.equal(frozen);
    });

    it("only admin can ramp / set fee", async () => {
      const { pool, trader } = await loadFixture(seeded);
      await expect(pool.connect(trader).rampA(200n, (await time.latest()) + 10 * 24 * 3600))
        .to.be.reverted;
      await expect(pool.connect(trader).setFee(1n)).to.be.reverted;
    });
  });

  it("setFee enforces the cap", async () => {
    const { pool, admin } = await loadFixture(seeded);
    await pool.connect(admin).setFee(100n);
    expect(await pool.feeBps()).to.equal(100n);
    await expect(pool.connect(admin).setFee(101n)).to.be.revertedWithCustomError(pool, "FeeTooHigh");
  });
});
