const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const WAD = 10n ** 18n;
const NATIVE = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("MultiCurrencyBurnRouter", function () {
  let router, registry, priceSource, wToken, admin, custodian, user, other;

  beforeEach(async () => {
    [admin, custodian, user, other] = await ethers.getSigners();

    const Reg = await ethers.getContractFactory("MockBurnStakeRegistry");
    registry = await Reg.deploy();

    const PS = await ethers.getContractFactory("FixedRatioPriceSource");
    priceSource = await PS.deploy(admin.address);

    const W = await ethers.getContractFactory("WrappedEcosystemToken");
    wToken = await W.deploy("Wrapped MELEK", "wMELEK", 18, ethers.id("MELEK"), admin.address, custodian.address);

    const R = await ethers.getContractFactory("MultiCurrencyBurnRouter");
    router = await R.deploy(admin.address, await registry.getAddress(), await priceSource.getAddress());

    // PRANA parity; wMELEK worth 0.5 PRANA.
    await priceSource.setRatio(NATIVE, WAD);
    await priceSource.setRatio(await wToken.getAddress(), WAD / 2n);

    // Allowlist + fund the user with wMELEK.
    await router.connect(admin).setCurrencyAllowed(await wToken.getAddress(), true);
    await wToken.connect(custodian).mint(user.address, 10_000n, ethers.ZeroHash);
  });

  // -------- native PRANA path --------
  it("burns native PRANA: sinks to dead, credits parity weight, records in registry", async () => {
    const deadBefore = await ethers.provider.getBalance(DEAD);
    await expect(router.connect(user).burnToMine(NATIVE, 1000n, { value: 1000n }))
      .to.emit(router, "BurnedToMine")
      .withArgs(user.address, NATIVE, 1000n, 1000n, true);

    expect(await ethers.provider.getBalance(DEAD)).to.equal(deadBefore + 1000n);
    expect(await registry.weightOf(user.address)).to.equal(1000n);
    expect(await registry.lastToken()).to.equal(NATIVE);
    expect(await registry.lastAmount()).to.equal(1000n);
    expect(await registry.lastWeightAdded()).to.equal(1000n);
  });

  it("reverts when native msg.value != amount", async () => {
    await expect(
      router.connect(user).burnToMine(NATIVE, 1000n, { value: 999n })
    ).to.be.revertedWithCustomError(router, "NativeAmountMismatch");
  });

  // -------- wrapped ERC-20 path --------
  it("burns a wrapped token: reduces totalSupply and credits normalized weight", async () => {
    const wAddr = await wToken.getAddress();
    await wToken.connect(user).approve(await router.getAddress(), 2000n);

    const supplyBefore = await wToken.totalSupply();
    await expect(router.connect(user).burnToMine(wAddr, 2000n))
      .to.emit(router, "BurnedToMine")
      .withArgs(user.address, wAddr, 2000n, 1000n, false); // 2000 * 0.5 = 1000 weight

    expect(await wToken.totalSupply()).to.equal(supplyBefore - 2000n); // true supply sink
    expect(await wToken.balanceOf(user.address)).to.equal(8000n);
    expect(await registry.weightOf(user.address)).to.equal(1000n);
    expect(await registry.lastToken()).to.equal(wAddr);
  });

  it("reverts if wrapped path is sent native value", async () => {
    const wAddr = await wToken.getAddress();
    await wToken.connect(user).approve(await router.getAddress(), 100n);
    await expect(
      router.connect(user).burnToMine(wAddr, 100n, { value: 1n })
    ).to.be.revertedWithCustomError(router, "UnexpectedNativeValue");
  });

  // -------- allowlist gating --------
  it("rejects a non-allowlisted wrapped token", async () => {
    const W = await ethers.getContractFactory("WrappedEcosystemToken");
    const evil = await W.deploy("Wrapped EVIL", "wEVIL", 18, ethers.id("EVIL"), admin.address, custodian.address);
    await evil.connect(custodian).mint(user.address, 100n, ethers.ZeroHash);
    await evil.connect(user).approve(await router.getAddress(), 100n);
    await expect(router.connect(user).burnToMine(await evil.getAddress(), 100n))
      .to.be.revertedWithCustomError(router, "CurrencyNotAllowed")
      .withArgs(await evil.getAddress());
  });

  it("admin can revoke an allowlisted currency", async () => {
    const wAddr = await wToken.getAddress();
    await router.connect(admin).setCurrencyAllowed(wAddr, false);
    await wToken.connect(user).approve(await router.getAddress(), 100n);
    await expect(router.connect(user).burnToMine(wAddr, 100n)).to.be.revertedWithCustomError(
      router,
      "CurrencyNotAllowed"
    );
  });

  it("gates allowlist + price-source setters to admin", async () => {
    await expect(
      router.connect(other).setCurrencyAllowed(await wToken.getAddress(), true)
    ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    await expect(
      router.connect(other).setPriceSource(await priceSource.getAddress())
    ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
  });

  it("cannot allowlist the NATIVE sentinel", async () => {
    await expect(
      router.connect(admin).setCurrencyAllowed(NATIVE, true)
    ).to.be.revertedWithCustomError(router, "ZeroAddress");
  });

  // -------- price normalization across currencies --------
  it("normalizes: $X of wMELEK credits same weight as $X of PRANA", async () => {
    const wAddr = await wToken.getAddress();
    // Burn 1000 PRANA -> 1000 weight. Burn 2000 wMELEK (@0.5) -> also 1000 weight (same $ value).
    await router.connect(user).burnToMine(NATIVE, 1000n, { value: 1000n });
    const afterNative = await registry.weightOf(user.address);

    await wToken.connect(user).approve(await router.getAddress(), 2000n);
    await router.connect(user).burnToMine(wAddr, 2000n);
    expect(await registry.weightOf(user.address)).to.equal(afterNative + 1000n);
  });

  it("reverts on zero amount and on zero computed weight", async () => {
    await expect(router.connect(user).burnToMine(NATIVE, 0n, { value: 0n })).to.be.revertedWithCustomError(
      router,
      "ZeroAmount"
    );
    // amount=1 with ratio 0.5e18 truncates to 0 weight -> ZeroWeight
    const wAddr = await wToken.getAddress();
    await wToken.connect(user).approve(await router.getAddress(), 1n);
    await expect(router.connect(user).burnToMine(wAddr, 1n)).to.be.revertedWithCustomError(
      router,
      "ZeroWeight"
    );
  });

  it("supports swapping the price source", async () => {
    const PS = await ethers.getContractFactory("FixedRatioPriceSource");
    const ps2 = await PS.deploy(admin.address);
    await ps2.setRatio(NATIVE, 3n * WAD); // now PRANA credits 3x
    await router.connect(admin).setPriceSource(await ps2.getAddress());
    await expect(router.connect(user).burnToMine(NATIVE, 100n, { value: 100n }))
      .to.emit(router, "BurnedToMine")
      .withArgs(user.address, NATIVE, 100n, 300n, true);
  });
});
