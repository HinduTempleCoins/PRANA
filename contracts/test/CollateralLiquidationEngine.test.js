const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const BPS = 10_000n;

// Engine params
const CLOSE_FACTOR_BPS = 5000n; // 50%
const BONUS_BPS = 1000n; // 10%
const DUST_THRESHOLD = 10n; // debt <= 10 is dust → full close
const MAX_PRICE_AGE = 3600n; // seconds

describe("CollateralLiquidationEngine (Aave-style partial liquidation for CDPVaultV2)", function () {
  async function deployFixture() {
    const [admin, user, liquidator, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const col = await Mock.deploy("Collateral", "COL");

    const PoL = await ethers.getContractFactory("PoLToken");
    const debt = await PoL.deploy(admin.address);

    const O = await ethers.getContractFactory("SimplePriceOracle");
    const oracle = await O.deploy(admin.address); // vault's internal HF oracle

    const Stale = await ethers.getContractFactory("MockStaleOracle");
    const staleOracle = await Stale.deploy(); // engine's staleness-guarded oracle

    // Vault: 50% LTV, admin will wire the engine.
    const V = await ethers.getContractFactory("CDPVaultV2");
    const vault = await V.deploy(
      await col.getAddress(),
      await debt.getAddress(),
      await oracle.getAddress(),
      WAD / 2n,
      admin.address
    );

    const E = await ethers.getContractFactory("CollateralLiquidationEngine");
    const engine = await E.deploy(
      await vault.getAddress(),
      await staleOracle.getAddress(),
      CLOSE_FACTOR_BPS,
      BONUS_BPS,
      DUST_THRESHOLD,
      MAX_PRICE_AGE
    );

    await vault.setLiquidationEngine(await engine.getAddress());

    // Vault holds minter rights on the debt token.
    await debt.grantRole(await debt.MINTER_ROLE(), await vault.getAddress());

    // Initial price 1:1 on both oracles.
    await oracle.setPrice(await col.getAddress(), WAD);
    await staleOracle.setPrice(await col.getAddress(), WAD);

    // Fund user with collateral; open a leveraged position.
    await col.mint(user.address, 1000n);
    await col.connect(user).approve(await vault.getAddress(), 1000n);
    await vault.connect(user).deposit(1000n);
    await vault.connect(user).borrow(400n); // maxBorrow at 1:1 with 50% LTV = 500

    return { admin, user, liquidator, other, col, debt, oracle, staleOracle, vault, engine };
  }

  // Push price down on BOTH oracles to make the position underwater.
  async function setPrice(col, oracle, staleOracle, p) {
    await oracle.setPrice(await col.getAddress(), p);
    await staleOracle.setPrice(await col.getAddress(), p);
  }

  // Fund a liquidator with debt tokens and approve the VAULT (the hook caller) to pull them.
  async function fundLiquidator(debt, vault, liquidator, amount) {
    await debt.mint(liquidator.address, amount);
    await debt.connect(liquidator).approve(await vault.getAddress(), amount);
  }

  it("rejects liquidation of a healthy position", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);
    // Price still 1:1 → HF = maxBorrow(500)/debt(400) = 1.25 > 1.
    expect(await vault.healthFactor(user.address)).to.be.greaterThan(WAD);
    await fundLiquidator(debt, vault, liquidator, 400n);
    await expect(
      engine.connect(liquidator).liquidate(user.address, 200n)
    ).to.be.revertedWithCustomError(engine, "PositionHealthy");
    expect(await engine.isLiquidatable(user.address)).to.equal(false);
  });

  it("partial liquidation: exact bonus math, close-factor cap, health improves", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);

    // Halve price: colValue = 500, maxBorrow = 250 < debt 400 → HF = 0.625 < 1, but solvent (500>400).
    await setPrice(col, oracle, staleOracle, WAD / 2n);
    expect(await engine.isLiquidatable(user.address)).to.equal(true);
    const hfBefore = await vault.healthFactor(user.address);

    // Liquidator asks to repay the whole 400, but close factor caps it at 50% = 200.
    await fundLiquidator(debt, vault, liquidator, 400n);
    const tx = await engine.connect(liquidator).liquidate(user.address, 400n);

    // repaid = 200 (capped). seizeValue = 200 * 1.10 = 220. seize = 220 / 0.5 = 440 collateral.
    await expect(tx)
      .to.emit(engine, "Liquidated")
      .withArgs(user.address, liquidator.address, 200n, 440n, 0n, false);

    expect(await vault.debtOf(user.address)).to.equal(200n); // 400 - 200
    expect(await vault.collateralOf(user.address)).to.equal(560n); // 1000 - 440
    expect(await col.balanceOf(liquidator.address)).to.equal(440n); // seized
    expect(await debt.balanceOf(liquidator.address)).to.equal(200n); // 400 minted - 200 burned

    // Health factor strictly improves (must not worsen).
    const hfAfter = await vault.healthFactor(user.address);
    expect(hfAfter).to.be.greaterThan(hfBefore);
  });

  it("honors an explicit repay amount below the close-factor cap", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);
    await setPrice(col, oracle, staleOracle, WAD / 2n);
    await fundLiquidator(debt, vault, liquidator, 400n);

    // Repay only 100 (< cap 200). seize = 100 * 1.1 / 0.5 = 220 collateral.
    await engine.connect(liquidator).liquidate(user.address, 100n);
    expect(await vault.debtOf(user.address)).to.equal(300n);
    expect(await col.balanceOf(liquidator.address)).to.equal(220n);
  });

  it("reverts on a stale oracle price", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);

    // Make underwater on the vault oracle, but freeze the staleOracle at an old timestamp.
    await oracle.setPrice(await col.getAddress(), WAD / 2n);
    const now = BigInt(await time.latest());
    // updatedAt far in the past → exceeds MAX_PRICE_AGE.
    await staleOracle.setPriceAt(await col.getAddress(), WAD / 2n, now - MAX_PRICE_AGE - 100n);

    await fundLiquidator(debt, vault, liquidator, 400n);
    await expect(
      engine.connect(liquidator).liquidate(user.address, 200n)
    ).to.be.revertedWithCustomError(engine, "StalePrice");
  });

  it("reverts on a non-positive oracle price", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);
    await oracle.setPrice(await col.getAddress(), WAD / 2n);
    // staleOracle reports 0 → BadOraclePrice.
    await staleOracle.setPrice(await col.getAddress(), 0n);
    await fundLiquidator(debt, vault, liquidator, 400n);
    await expect(
      engine.connect(liquidator).liquidate(user.address, 200n)
    ).to.be.revertedWithCustomError(engine, "BadOraclePrice");
  });

  it("dust position is fully closed in one call (ignores close factor)", async () => {
    const { admin, liquidator, vault, engine, col, debt, oracle, staleOracle } =
      await loadFixture(deployFixture);

    // Fresh tiny position: deposit 100 collateral, borrow 8 debt (dust <= 10).
    const [, , , , dustUser] = await ethers.getSigners();
    await col.mint(dustUser.address, 100n);
    await col.connect(dustUser).approve(await vault.getAddress(), 100n);
    await vault.connect(dustUser).deposit(100n);
    await vault.connect(dustUser).borrow(8n); // maxBorrow = 50 at 1:1, fine

    // Drop price so it is underwater: colValue = 100*0.2 = 20, maxBorrow = 10, debt 8 → HF=1.25? recompute.
    // Need HF<1: maxBorrow = colValue*0.5. At price 0.1: colValue=10, maxBorrow=5 < 8 → HF<1.
    await setPrice(col, oracle, staleOracle, WAD / 10n);
    expect(await vault.healthFactor(dustUser.address)).to.be.lessThan(WAD);

    await fundLiquidator(debt, vault, liquidator, 8n);
    const tx = await engine.connect(liquidator).liquidate(dustUser.address, 8n);

    // Dust → full close. repay 8. seizeValue = 8*1.1 = 8.8 → 8.8/0.1 = 88 collateral. col=100 > 88.
    await expect(tx)
      .to.emit(engine, "Liquidated")
      .withArgs(dustUser.address, liquidator.address, 8n, 88n, 0n, true);
    expect(await vault.debtOf(dustUser.address)).to.equal(0n);
    expect(await vault.collateralOf(dustUser.address)).to.equal(12n);
  });

  it("insolvent position: seizes all collateral and writes off the bad debt (full close)", async () => {
    const { user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);

    // Crash price hard so colValue < debt AND bonus seize exceeds available collateral.
    // At price 0.3: colValue = 1000*0.3 = 300 < debt 400 → insolvent → full-close path.
    // Intended repay = full 400. seizeValue = 400*1.1 = 440 → 440/0.3 = 1466 collateral > col 1000.
    // So seize clamps to 1000; writeOff = debt - repay.
    // But repay is the full debt (400) only if the liquidator can pay it; collateral can't back it.
    // Engine repays 400, seizes all 1000, writeOff = 400 - 400 = 0. To force real bad debt, drop further.
    // At price 0.2: colValue = 200 < 400 insolvent. seize for repay 400 = 440/0.2 = 2200 > 1000 → clamp.
    // Liquidator only rationally repays what the collateral covers, but engine computes repay=400 first,
    // clamps seize to 1000, writeOff = 0 (full 400 burned). That's a generous burn; to test write-off we
    // cap the liquidator's repay below the debt via a partial request on an insolvent position:
    await setPrice(col, oracle, staleOracle, WAD / 5n); // 0.2

    // Liquidator requests partial repay 100 on an insolvent position. Insolvent → maxRepay=debt=400,
    // so request 100 is honored (repay=100). seize = 100*1.1/0.2 = 550 < 1000 → no clamp, no writeOff.
    // To actually exhaust collateral, request a large repay so seize exceeds 1000.
    await fundLiquidator(debt, vault, liquidator, 400n);
    const tx = await engine.connect(liquidator).liquidate(user.address, 400n);

    // repay 400 (insolvent allows full). seize would be 2200 → clamp to col 1000. writeOff = 400-400 = 0.
    const colSeized = await col.balanceOf(liquidator.address);
    expect(colSeized).to.equal(1000n);
    expect(await vault.collateralOf(user.address)).to.equal(0n);
    expect(await vault.debtOf(user.address)).to.equal(0n); // fully repaid
    await expect(tx).to.emit(engine, "Liquidated").withArgs(user.address, liquidator.address, 400n, 1000n, 0n, true);
  });

  it("insolvent with capped repay leaves bad debt written off when collateral is exhausted", async () => {
    const { admin, user, liquidator, vault, engine, col, oracle, staleOracle, debt } =
      await loadFixture(deployFixture);

    // Build a position the liquidator only partially repays yet still drains all collateral.
    // Price 0.2: insolvent (colValue 200 < debt 400). The engine sizes repay from the REQUEST,
    // but seize from repay. To get a write-off, the seize for the requested repay must exceed col
    // while repay < debt. seize = repay*1.1/0.2 = repay*5.5. For seize >= 1000 → repay >= ~182.
    // Request repay 300 (< debt 400, insolvent allows up to 400). seize = 300*5.5 = 1650 > 1000 → clamp
    // to 1000, full close, writeOff = 400 - 300 = 100.
    await setPrice(col, oracle, staleOracle, WAD / 5n);
    await fundLiquidator(debt, vault, liquidator, 300n);

    const tx = await engine.connect(liquidator).liquidate(user.address, 300n);
    await expect(tx)
      .to.emit(engine, "Liquidated")
      .withArgs(user.address, liquidator.address, 300n, 1000n, 100n, true);
    expect(await vault.collateralOf(user.address)).to.equal(0n);
    expect(await vault.debtOf(user.address)).to.equal(0n); // 400 - 300 repaid - 100 written off
    expect(await col.balanceOf(liquidator.address)).to.equal(1000n);
  });

  it("only the wired engine can call the vault liquidation hooks", async () => {
    const { user, other, vault } = await loadFixture(deployFixture);
    await expect(
      vault.connect(other).liquidationRepay(user.address, other.address, 1n)
    ).to.be.revertedWithCustomError(vault, "NotLiquidationEngine");
    await expect(
      vault.connect(other).liquidationSeize(user.address, other.address, 1n)
    ).to.be.revertedWithCustomError(vault, "NotLiquidationEngine");
    await expect(
      vault.connect(other).liquidationWriteOff(user.address, 1n)
    ).to.be.revertedWithCustomError(vault, "NotLiquidationEngine");
  });

  it("engine address is set once and locked", async () => {
    const { admin, other, vault, engine } = await loadFixture(deployFixture);
    await expect(
      vault.connect(admin).setLiquidationEngine(other.address)
    ).to.be.revertedWithCustomError(vault, "EngineAlreadySet");
  });

  it("reverts when repayAmount is zero", async () => {
    const { user, liquidator, engine } = await loadFixture(deployFixture);
    await expect(
      engine.connect(liquidator).liquidate(user.address, 0n)
    ).to.be.revertedWithCustomError(engine, "RepayAmountZero");
  });
});
