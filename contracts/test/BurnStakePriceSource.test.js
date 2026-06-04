const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

describe("FixedRatioPriceSource", function () {
  let src, admin, other;
  // Canonical (all-lowercase) form so .withArgs matches ethers' EIP-55-normalized decode.
  const tokenA = "0x000000000000000000000000000000000000a001";
  const tokenB = "0x000000000000000000000000000000000000b002";

  beforeEach(async () => {
    [admin, other] = await ethers.getSigners();
    const S = await ethers.getContractFactory("FixedRatioPriceSource");
    src = await S.deploy(admin.address);
  });

  it("computes weight = amount * ratioWad / 1e18", async () => {
    await src.setRatio(tokenA, WAD); // parity
    expect(await src.weightOf(tokenA, 1000n)).to.equal(1000n);

    await src.setRatio(tokenB, WAD / 2n); // worth 0.5 PRANA
    expect(await src.weightOf(tokenB, 1000n)).to.equal(500n);

    await src.setRatio(tokenB, 2n * WAD); // worth 2 PRANA
    expect(await src.weightOf(tokenB, 1000n)).to.equal(2000n);
  });

  it("emits RatioSet and gates setRatio to SETTER_ROLE", async () => {
    await expect(src.setRatio(tokenA, WAD)).to.emit(src, "RatioSet").withArgs(tokenA, WAD);
    await expect(src.connect(other).setRatio(tokenA, WAD)).to.be.revertedWithCustomError(
      src,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("fails closed on an unpriced token", async () => {
    await expect(src.weightOf(tokenA, 1n))
      .to.be.revertedWithCustomError(src, "TokenNotPriced")
      .withArgs(tokenA);
  });
});

describe("OracleBurnStakePriceSource", function () {
  let oracle, src, admin;
  const prana = "0x0000000000000000000000000000000000000DAD";
  const wmelek = "0x0000000000000000000000000000000000000E1E";

  beforeEach(async () => {
    [admin] = await ethers.getSigners();
    const O = await ethers.getContractFactory("SimplePriceOracle");
    oracle = await O.deploy(admin.address);
    const S = await ethers.getContractFactory("OracleBurnStakePriceSource");
    src = await S.deploy(admin.address, await oracle.getAddress(), prana);
  });

  it("weight = amount * priceOf(token) / priceOf(PRANA)", async () => {
    // PRANA = $1 (1e18), wMELEK = $0.50 (0.5e18) -> burning 1000 wMELEK = 500 weight
    await oracle.setPrice(prana, WAD);
    await oracle.setPrice(wmelek, WAD / 2n);
    expect(await src.weightOf(wmelek, 1000n)).to.equal(500n);

    // wMELEK = $2 -> 1000 wMELEK = 2000 weight
    await oracle.setPrice(wmelek, 2n * WAD);
    expect(await src.weightOf(wmelek, 1000n)).to.equal(2000n);
  });

  it("PRANA priced same as PRANA-ref gives parity", async () => {
    await oracle.setPrice(prana, 3n * WAD);
    await oracle.setPrice(wmelek, 3n * WAD);
    expect(await src.weightOf(wmelek, 777n)).to.equal(777n);
  });

  it("fails closed when token or PRANA is unpriced", async () => {
    await expect(src.weightOf(wmelek, 1n)).to.be.revertedWithCustomError(src, "TokenNotPriced");
    await oracle.setPrice(wmelek, WAD);
    await expect(src.weightOf(wmelek, 1n)).to.be.revertedWithCustomError(src, "PranaNotPriced");
  });
});
