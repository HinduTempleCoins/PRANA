const { expect } = require("chai");
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseEther(String(n));

describe("SettlementFeeHook", function () {
  let hook, oracle, treasury, token, admin, ledger, payee, attacker;
  let price, emission, counter;

  const PRANA_KEY = "0x000000000000000000000000000000000000dEaD";

  const PARAMS = {
    floorBps: 10,
    ceilingBps: 500,
    steadyFloorBps: 10,
    steadyCeilBps: 300,
    bootstrapCeilBps: 500,
    machineThresholdX: 1000,
    refLowPrice: e18("1"),
    refHighPrice: e18("10"),
    bootstrapEpochs: 100,
  };

  beforeEach(async () => {
    [admin, ledger, payee, attacker] = await ethers.getSigners();

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
      PRANA_KEY,
      await emission.getAddress(),
      await counter.getAddress(),
      PARAMS
    );

    const Tre = await ethers.getContractFactory("HathorFeeTreasury");
    treasury = await Tre.deploy(admin.address, admin.address);

    const H = await ethers.getContractFactory("SettlementFeeHook");
    hook = await H.deploy(
      admin.address,
      ledger.address,
      await treasury.getAddress(),
      await oracle.getAddress()
    );

    const M = await ethers.getContractFactory("MockERC20");
    token = await M.deploy("Prana", "PRANA");

    // The "ledger" holds the payout token and approves the hook to pull it.
    await token.mint(ledger.address, e18("1000000"));
    await token.connect(ledger).approve(await hook.getAddress(), ethers.MaxUint256);
  });

  // Default state: cheap PRANA, bootstrap, below X => 5% (500 bps).
  async function setRate({ p = e18("1"), epoch = 0, machines = 0 } = {}) {
    await price.setPrice(PRANA_KEY, p);
    await emission.setEpoch(epoch);
    await counter.setCount(machines);
  }

  it("rejects zero wiring at construction", async () => {
    const H = await ethers.getContractFactory("SettlementFeeHook");
    await expect(
      H.deploy(admin.address, ledger.address, ethers.ZeroAddress, await oracle.getAddress())
    ).to.be.revertedWithCustomError(H, "ZeroAddress");
    await expect(
      H.deploy(admin.address, ledger.address, await treasury.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(H, "ZeroAddress");
  });

  it("quote() reflects the oracle rate (countercyclical)", async () => {
    await setRate({ p: e18("1") }); // 5%
    let [fee, net, rate] = await hook.quote(e18("100"));
    expect(rate).to.equal(500);
    expect(fee).to.equal(e18("5"));
    expect(net).to.equal(e18("95"));

    await setRate({ p: e18("10") }); // dear -> steady floor 0.1%
    [fee, net, rate] = await hook.quote(e18("100"));
    expect(rate).to.equal(10);
    expect(fee).to.equal(e18("0.1"));
    expect(net).to.equal(e18("99.9"));
  });

  it("only the ledger (LEDGER_ROLE) can settle", async () => {
    await setRate();
    await expect(
      hook.connect(attacker).settle(await token.getAddress(), payee.address, e18("100"))
    ).to.be.reverted;
  });

  it("settle skims to treasury, pays net to payee, returns net", async () => {
    await setRate({ p: e18("1") }); // 5%
    const amount = e18("100");

    const net = await hook
      .connect(ledger)
      .settle.staticCall(await token.getAddress(), payee.address, amount);
    expect(net).to.equal(e18("95"));

    await expect(hook.connect(ledger).settle(await token.getAddress(), payee.address, amount))
      .to.emit(hook, "Skimmed")
      .withArgs(await token.getAddress(), payee.address, amount, e18("5"), e18("95"), 500);

    expect(await token.balanceOf(payee.address)).to.equal(e18("95"));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(e18("5"));
  });

  it("rate is pulled live from the oracle at settle time", async () => {
    await setRate({ p: e18("10") }); // 0.1%
    const amount = e18("1000");
    await hook.connect(ledger).settle(await token.getAddress(), payee.address, amount);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(e18("1")); // 0.1% of 1000
    expect(await token.balanceOf(payee.address)).to.equal(e18("999"));
  });

  it("fee==0 dust path: net fully paid, treasury untouched", async () => {
    await setRate({ p: e18("10") }); // 0.1%
    // amount so small that fee floors to 0: 0.1% of 100 wei = 0 (floor).
    const amount = 100n;
    await hook.connect(ledger).settle(await token.getAddress(), payee.address, amount);
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(0n);
    expect(await token.balanceOf(payee.address)).to.equal(100n);
  });

  it("RATE_ADMIN can repoint the oracle; treasury is immutable", async () => {
    const O = await ethers.getContractFactory("CountercyclicalFeeOracle");
    const oracle2 = await O.deploy(
      admin.address,
      await price.getAddress(),
      PRANA_KEY,
      await emission.getAddress(),
      await counter.getAddress(),
      PARAMS
    );
    await expect(hook.connect(attacker).setRateOracle(await oracle2.getAddress())).to.be.reverted;
    await expect(hook.connect(admin).setRateOracle(await oracle2.getAddress())).to.emit(
      hook,
      "RateOracleUpdated"
    );
    // No setter for treasury exists.
    expect(hook.interface.fragments.some((f) => f.name === "setTreasury")).to.equal(false);
  });
});
