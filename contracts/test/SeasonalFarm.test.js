const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("SeasonalFarm (ERC-1155 block-paced farming)", function () {
  const BASE_URI = "https://prana.example/farm/{id}.json";
  const GROWTH_BLOCKS = 20n;
  const WATER_BOOST = 5n; // blocks removed per water unit
  const BASE_YIELD = 100n;
  const DENOM = 10_000n;

  // Id-range layout mirrors the contract constants.
  const RANGE = 0x1000000n;
  const PLOT_BASE = 0n * RANGE;
  const SEED_BASE = 1n * RANGE;
  const WATER_BASE = 2n * RANGE;
  const YIELD_BASE = 3n * RANGE;

  // Concrete ids used in tests (offset 7 within each class).
  const OFFSET = 7n;
  const PLOT = PLOT_BASE + OFFSET;
  const SEED = SEED_BASE + OFFSET;
  const WATER = WATER_BASE + OFFSET;
  const YIELD = YIELD_BASE + OFFSET;

  async function deployFixture() {
    const [admin, farmer, other] = await ethers.getSigners();

    const Farm = await ethers.getContractFactory("SeasonalFarm");
    const farm = await Farm.deploy(
      BASE_URI,
      GROWTH_BLOCKS,
      WATER_BOOST,
      BASE_YIELD,
      admin.address
    );
    await farm.waitForDeployment();

    return { farm, admin, farmer, other };
  }

  // Give `farmer` a plot, seeds, and water.
  async function stockFarmer(farm, admin, farmer, { seeds = 1n, water = 0n } = {}) {
    await farm.connect(admin).mint(farmer.address, PLOT, 1n, "0x");
    if (seeds > 0n) await farm.connect(admin).mint(farmer.address, SEED, seeds, "0x");
    if (water > 0n) await farm.connect(admin).mint(farmer.address, WATER, water, "0x");
  }

  it("full lifecycle: plant burns seed, harvest after maturity mints yield", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    expect(await farm.balanceOf(farmer.address, SEED)).to.equal(1n);

    await expect(farm.connect(farmer).plant(SEED, PLOT, 0n))
      .to.emit(farm, "Planted");

    // Seed burned on plant.
    expect(await farm.balanceOf(farmer.address, SEED)).to.equal(0n);
    expect(await farm.isReady(PLOT)).to.equal(false);

    // Mature it.
    await mine(GROWTH_BLOCKS);
    expect(await farm.isReady(PLOT)).to.equal(true);

    await expect(farm.connect(farmer).harvest(PLOT))
      .to.emit(farm, "Harvested")
      .withArgs(farmer.address, PLOT, YIELD, BASE_YIELD);

    expect(await farm.balanceOf(farmer.address, YIELD)).to.equal(BASE_YIELD);
    // Plot freed and still owned.
    expect(await farm.balanceOf(farmer.address, PLOT)).to.equal(1n);
  });

  it("harvest before maturity reverts NotMature", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    await farm.connect(farmer).plant(SEED, PLOT, 0n);
    await mine(GROWTH_BLOCKS - 3n); // not yet mature

    await expect(farm.connect(farmer).harvest(PLOT))
      .to.be.revertedWithCustomError(farm, "NotMature")
      .withArgs(PLOT);
  });

  it("water shortens growth and is burned as a sink", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    // 3 water * 5 = 15 blocks off -> matures in 5 blocks.
    await stockFarmer(farm, admin, farmer, { seeds: 1n, water: 3n });

    await farm.connect(farmer).plant(SEED, PLOT, 3n);
    expect(await farm.balanceOf(farmer.address, WATER)).to.equal(0n); // burned

    await mine(5n);
    expect(await farm.isReady(PLOT)).to.equal(true);
    await farm.connect(farmer).harvest(PLOT);
    expect(await farm.balanceOf(farmer.address, YIELD)).to.equal(BASE_YIELD);
  });

  it("cannot double-plant an occupied plot", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 2n });

    await farm.connect(farmer).plant(SEED, PLOT, 0n);
    await expect(farm.connect(farmer).plant(SEED, PLOT, 0n))
      .to.be.revertedWithCustomError(farm, "PlotOccupied")
      .withArgs(PLOT);

    // After harvest the plot can be replanted.
    await mine(GROWTH_BLOCKS);
    await farm.connect(farmer).harvest(PLOT);
    await expect(farm.connect(farmer).plant(SEED, PLOT, 0n)).to.emit(farm, "Planted");
  });

  it("planting on a plot you do not own reverts", async function () {
    const { farm, admin, farmer, other } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });
    // Give `other` a seed but no plot.
    await farm.connect(admin).mint(other.address, SEED, 1n, "0x");

    await expect(farm.connect(other).plant(SEED, PLOT, 0n))
      .to.be.revertedWithCustomError(farm, "NotPlotOwner")
      .withArgs(PLOT);
  });

  it("harvesting a plot you do not own reverts", async function () {
    const { farm, admin, farmer, other } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });
    await farm.connect(farmer).plant(SEED, PLOT, 0n);
    await mine(GROWTH_BLOCKS);

    await expect(farm.connect(other).harvest(PLOT))
      .to.be.revertedWithCustomError(farm, "NotPlotOwner")
      .withArgs(PLOT);
  });

  it("rejects non-seed id passed to plant and non-plot id", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    // PLOT id where a seed is expected.
    await expect(farm.connect(farmer).plant(PLOT, PLOT, 0n))
      .to.be.revertedWithCustomError(farm, "NotASeed")
      .withArgs(PLOT);

    // SEED id where a plot is expected.
    await expect(farm.connect(farmer).plant(SEED, SEED, 0n))
      .to.be.revertedWithCustomError(farm, "NotAPlot")
      .withArgs(SEED);
  });

  it("season modifier scales yield (advanceSeason)", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    // Bountiful season: 1.5x.
    await expect(farm.connect(admin).advanceSeason(15_000n))
      .to.emit(farm, "SeasonAdvanced")
      .withArgs(1n, 15_000n);
    expect(await farm.season()).to.equal(1n);

    await farm.connect(farmer).plant(SEED, PLOT, 0n);
    await mine(GROWTH_BLOCKS);
    await farm.connect(farmer).harvest(PLOT);

    const expected = (BASE_YIELD * 15_000n) / DENOM; // 150
    expect(await farm.balanceOf(farmer.address, YIELD)).to.equal(expected);
  });

  it("crop locks the modifier of its plant season even if the season later changes", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    // Season 1 at 0.5x; plant during it.
    await farm.connect(admin).advanceSeason(5_000n);
    await farm.connect(farmer).plant(SEED, PLOT, 0n);

    // Season advances to 2 (2x) before harvest, but the crop keeps season 1's 0.5x.
    await farm.connect(admin).advanceSeason(20_000n);
    await mine(GROWTH_BLOCKS);
    await farm.connect(farmer).harvest(PLOT);

    const expected = (BASE_YIELD * 5_000n) / DENOM; // 50
    expect(await farm.balanceOf(farmer.address, YIELD)).to.equal(expected);
  });

  it("setSeasonModifier updates the current season multiplier", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await stockFarmer(farm, admin, farmer, { seeds: 1n });

    await farm.connect(admin).setSeasonModifier(20_000n); // current season 0 -> 2x
    await farm.connect(farmer).plant(SEED, PLOT, 0n);
    await mine(GROWTH_BLOCKS);
    await farm.connect(farmer).harvest(PLOT);

    expect(await farm.balanceOf(farmer.address, YIELD)).to.equal(BASE_YIELD * 2n);
  });

  it("only MODIFIER_ROLE can change season state", async function () {
    const { farm, farmer } = await loadFixture(deployFixture);
    const MODIFIER_ROLE = await farm.MODIFIER_ROLE();
    await expect(farm.connect(farmer).advanceSeason(12_000n))
      .to.be.revertedWithCustomError(farm, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(farmer.address), MODIFIER_ROLE);
    await expect(farm.connect(farmer).setSeasonModifier(12_000n))
      .to.be.revertedWithCustomError(farm, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(farmer.address), MODIFIER_ROLE);
  });

  it("rejects a zero season modifier", async function () {
    const { farm, admin } = await loadFixture(deployFixture);
    await expect(
      farm.connect(admin).advanceSeason(0n)
    ).to.be.revertedWithCustomError(farm, "ZeroModifier");
    await expect(
      farm.connect(admin).setSeasonModifier(0n)
    ).to.be.revertedWithCustomError(farm, "ZeroModifier");
  });

  it("only MINTER_ROLE can mint, and yield ids cannot be pre-minted", async function () {
    const { farm, farmer } = await loadFixture(deployFixture);
    await expect(
      farm.connect(farmer).mint(farmer.address, PLOT, 1n, "0x")
    ).to.be.revertedWithCustomError(farm, "AccessControlUnauthorizedAccount");
  });

  it("MINTER cannot mint yield-range ids directly", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    await expect(
      farm.connect(admin).mint(farmer.address, YIELD, 1n, "0x")
    ).to.be.revertedWith("yield via harvest only");
  });

  it("planting reverts if the farmer has no seed to burn", async function () {
    const { farm, admin, farmer } = await loadFixture(deployFixture);
    // Plot but zero seeds.
    await stockFarmer(farm, admin, farmer, { seeds: 0n });
    await expect(
      farm.connect(farmer).plant(SEED, PLOT, 0n)
    ).to.be.revertedWithCustomError(farm, "ERC1155InsufficientBalance");
  });

  it("id-range helpers classify ids correctly", async function () {
    const { farm } = await loadFixture(deployFixture);
    expect(await farm.isPlot(PLOT)).to.equal(true);
    expect(await farm.isSeed(SEED)).to.equal(true);
    expect(await farm.isWater(WATER)).to.equal(true);
    expect(await farm.isYield(YIELD)).to.equal(true);
    expect(await farm.yieldIdForSeed(SEED)).to.equal(YIELD);
  });
});
