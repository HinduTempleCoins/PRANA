const { expect } = require("chai");
const { ethers } = require("hardhat");

// publicly-known anvil/hardhat dev addresses used as plain destination sinks (lowercase literals)
const DAO_FUND = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const MAIN_DISTRIBUTOR = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

describe("DAOFundEmissionSplit", function () {
  let split, token, admin, other;
  const BPS_DENOMINATOR = 10000n;
  const MAX_DAO_BPS = 2000n;
  const TEN_PCT = 1000n; // 10%

  beforeEach(async () => {
    [admin, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Reward", "RWD");

    const Split = await ethers.getContractFactory("DAOFundEmissionSplit");
    split = await Split.deploy(admin.address, DAO_FUND, MAIN_DISTRIBUTOR, TEN_PCT);
  });

  it("routes 10% to the DAO fund and the remainder onward to the main distributor", async () => {
    const inflow = ethers.parseEther("1000");
    await token.mint(await split.getAddress(), inflow);

    const expectedDao = (inflow * TEN_PCT) / BPS_DENOMINATOR; // 100
    const expectedMain = inflow - expectedDao; // 900

    await expect(split.distribute(await token.getAddress()))
      .to.emit(split, "Split")
      .withArgs(await token.getAddress(), inflow, expectedDao, expectedMain);

    expect(await token.balanceOf(DAO_FUND)).to.equal(expectedDao);
    expect(await token.balanceOf(MAIN_DISTRIBUTOR)).to.equal(expectedMain);
    // nothing left behind
    expect(await token.balanceOf(await split.getAddress())).to.equal(0n);
  });

  it("leaves no dust: dao + main always equals the full inflow", async () => {
    // a non-round amount that does not divide cleanly by bps
    const inflow = 1234567n;
    await token.mint(await split.getAddress(), inflow);
    await split.distribute(await token.getAddress());

    const dao = await token.balanceOf(DAO_FUND);
    const main = await token.balanceOf(MAIN_DISTRIBUTOR);
    expect(dao + main).to.equal(inflow);
    expect(dao).to.equal((inflow * TEN_PCT) / BPS_DENOMINATOR);
  });

  it("no-ops when the balance is zero", async () => {
    await expect(split.distribute(await token.getAddress())).to.not.emit(split, "Split");
    expect(await token.balanceOf(DAO_FUND)).to.equal(0n);
  });

  it("admin can change the bps within the cap and it takes effect", async () => {
    await expect(split.connect(admin).setDaoBps(MAX_DAO_BPS))
      .to.emit(split, "Configured")
      .withArgs(MAX_DAO_BPS, ethers.getAddress(DAO_FUND), ethers.getAddress(MAIN_DISTRIBUTOR));
    expect(await split.daoBps()).to.equal(MAX_DAO_BPS);

    const inflow = ethers.parseEther("100");
    await token.mint(await split.getAddress(), inflow);
    await split.distribute(await token.getAddress());

    const expectedDao = (inflow * MAX_DAO_BPS) / BPS_DENOMINATOR; // 20%
    expect(await token.balanceOf(DAO_FUND)).to.equal(expectedDao);
  });

  it("enforces the bps cap on construction", async () => {
    const Split = await ethers.getContractFactory("DAOFundEmissionSplit");
    await expect(
      Split.deploy(admin.address, DAO_FUND, MAIN_DISTRIBUTOR, MAX_DAO_BPS + 1n)
    )
      .to.be.revertedWithCustomError(split, "BpsAboveCap")
      .withArgs(MAX_DAO_BPS + 1n, MAX_DAO_BPS);
  });

  it("enforces the bps cap on setDaoBps", async () => {
    await expect(split.connect(admin).setDaoBps(MAX_DAO_BPS + 1n))
      .to.be.revertedWithCustomError(split, "BpsAboveCap")
      .withArgs(MAX_DAO_BPS + 1n, MAX_DAO_BPS);
  });

  it("only admin can change the bps", async () => {
    await expect(
      split.connect(other).setDaoBps(500n)
    ).to.be.revertedWithCustomError(split, "AccessControlUnauthorizedAccount");
  });

  it("rejects zero addresses in the constructor", async () => {
    const Split = await ethers.getContractFactory("DAOFundEmissionSplit");
    await expect(
      Split.deploy(ethers.ZeroAddress, DAO_FUND, MAIN_DISTRIBUTOR, TEN_PCT)
    ).to.be.revertedWithCustomError(split, "ZeroAddress");
  });
});
