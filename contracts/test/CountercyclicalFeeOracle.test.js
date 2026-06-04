const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRANA = "0x000000000000000000000000000000000000dEaD"; // any address as the priced token key
const e18 = (n) => ethers.parseEther(String(n));

// Recommended-ish defaults.
const DEFAULTS = (X = 1000n) => ({
  floorBps: 10,
  ceilingBps: 500,
  steadyFloorBps: 10, // 0.10%
  steadyCeilBps: 300, // 3.00%
  bootstrapCeilBps: 500, // 5.00%
  machineThresholdX: X,
  refLowPrice: e18("1"), // PRANA cheap
  refHighPrice: e18("10"), // PRANA dear
  bootstrapEpochs: 100,
});

describe("CountercyclicalFeeOracle", function () {
  let oracle, price, emission, counter, admin, other;

  async function deploy(params) {
    const Price = await ethers.getContractFactory("MockStaleOracle");
    price = await Price.deploy();
    const Em = await ethers.getContractFactory("MockEmissionPhase");
    emission = await Em.deploy();
    const Cnt = await ethers.getContractFactory("MockVerifiedCounter");
    counter = await Cnt.deploy();

    const O = await ethers.getContractFactory("CountercyclicalFeeOracle");
    oracle = await O.deploy(
      admin.address,
      await price.getAddress(),
      PRANA,
      await emission.getAddress(),
      await counter.getAddress(),
      params
    );
  }

  beforeEach(async () => {
    [admin, other] = await ethers.getSigners();
    await deploy(DEFAULTS());
  });

  async function setState({ p, epoch = 0, machines = 0 }) {
    await price.setPrice(PRANA, p);
    await emission.setEpoch(epoch);
    await counter.setCount(machines);
  }

  it("rejects bad params at construction", async () => {
    const O = await ethers.getContractFactory("CountercyclicalFeeOracle");
    const bad = { ...DEFAULTS(), floorBps: 0 };
    await expect(
      O.deploy(
        admin.address,
        await price.getAddress(),
        PRANA,
        await emission.getAddress(),
        await counter.getAddress(),
        bad
      )
    ).to.be.revertedWithCustomError(O, "BadBounds");

    const badBand = { ...DEFAULTS(), bootstrapCeilBps: 600 }; // > ceiling 500
    await expect(
      O.deploy(
        admin.address,
        await price.getAddress(),
        PRANA,
        await emission.getAddress(),
        await counter.getAddress(),
        badBand
      )
    ).to.be.revertedWithCustomError(O, "BadBand");

    const badRefs = { ...DEFAULTS(), refLowPrice: e18("10"), refHighPrice: e18("10") };
    await expect(
      O.deploy(
        admin.address,
        await price.getAddress(),
        PRANA,
        await emission.getAddress(),
        await counter.getAddress(),
        badRefs
      )
    ).to.be.revertedWithCustomError(O, "BadPriceRefs");
  });

  it("BOOTSTRAP band when below X and within phase: cheap PRANA -> ~5% ceiling", async () => {
    await setState({ p: e18("1"), epoch: 0, machines: 0 }); // at/below refLow
    expect(await oracle.inBootstrap()).to.equal(true);
    expect(await oracle.currentRateBps()).to.equal(500); // bootstrapCeil
  });

  it("countercyclical: dear PRANA -> band low edge (steady floor)", async () => {
    await setState({ p: e18("10"), epoch: 0, machines: 0 }); // at/above refHigh
    expect(await oracle.currentRateBps()).to.equal(10); // steadyFloor (band low)
  });

  it("interpolates between refLow and refHigh (bootstrap band)", async () => {
    // midpoint price 5.5e18 => frac 0.5 => rate = high - 0.5*(high-low) = 500 - 0.5*490 = 255
    await setState({ p: e18("5.5"), epoch: 0, machines: 0 });
    expect(await oracle.currentRateBps()).to.equal(255);
  });

  it("STEPS DOWN past threshold X: crossing X switches to the steady band", async () => {
    // Cheap PRANA, but X crossed => steady band (ceil 300) not bootstrap (500).
    await setState({ p: e18("1"), epoch: 0, machines: 1000 }); // machines >= X(1000)
    expect(await oracle.inBootstrap()).to.equal(false);
    expect(await oracle.currentRateBps()).to.equal(300); // steadyCeil, not 500
  });

  it("phase taper: bootstrap band unavailable once emission phase matures (even pre-X)", async () => {
    await setState({ p: e18("1"), epoch: 100, machines: 0 }); // epoch >= bootstrapEpochs
    expect(await oracle.inBootstrap()).to.equal(false);
    expect(await oracle.currentRateBps()).to.equal(300); // steady ceil
  });

  it("output is always clamped within [floor, ceiling]", async () => {
    // Drive a configuration where band low < floor would matter; clamp guarantees floor.
    await setState({ p: e18("100"), epoch: 0, machines: 5000 }); // very dear, far above refHigh
    const r = await oracle.currentRateBps();
    expect(r).to.be.gte(10);
    expect(r).to.be.lte(500);
  });

  it("only PARAM_SETTER_ROLE can update params, and output stays bounded", async () => {
    const p = DEFAULTS(50n);
    await expect(oracle.connect(other).setParams(p)).to.be.reverted;
    await expect(oracle.connect(admin).setParams(p)).to.emit(oracle, "ParamsUpdated");

    // Now X is 50; with 60 machines we are in steady band.
    await setState({ p: e18("1"), epoch: 0, machines: 60 });
    expect(await oracle.currentRateBps()).to.equal(300);
  });

  it("there is no setter on the OUTPUT (only params)", async () => {
    // The contract exposes currentRateBps as a view; assert no state-mutating rate setter exists.
    expect(oracle.interface.fragments.some((f) => f.name === "setRate")).to.equal(false);
    expect(oracle.interface.fragments.some((f) => f.name === "currentRateBps")).to.equal(true);
  });
});
