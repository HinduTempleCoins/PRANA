const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const ORIGIN_REF = ethers.id("MELEK@origin");

describe("WrappedEcosystemToken", function () {
  let token, admin, custodian, user, other;

  beforeEach(async () => {
    [admin, custodian, user, other] = await ethers.getSigners();
    const T = await ethers.getContractFactory("WrappedEcosystemToken");
    token = await T.deploy("Wrapped MELEK", "wMELEK", 18, ORIGIN_REF, admin.address, custodian.address);
  });

  it("sets metadata, decimals, originRef and roles", async () => {
    expect(await token.name()).to.equal("Wrapped MELEK");
    expect(await token.symbol()).to.equal("wMELEK");
    expect(await token.decimals()).to.equal(18);
    expect(await token.originRef()).to.equal(ORIGIN_REF);
    const ADMIN = await token.DEFAULT_ADMIN_ROLE();
    const CUST = await token.CUSTODIAN_ROLE();
    expect(await token.hasRole(ADMIN, admin.address)).to.equal(true);
    expect(await token.hasRole(CUST, custodian.address)).to.equal(true);
  });

  it("honors a non-18 decimals value", async () => {
    const T = await ethers.getContractFactory("WrappedEcosystemToken");
    const t6 = await T.deploy("Wrapped CURE", "CURE", 6, ethers.id("CURE"), admin.address, custodian.address);
    expect(await t6.decimals()).to.equal(6);
  });

  it("custodian mints on observed origin lock and emits WrappedMinted", async () => {
    const lockRef = ethers.id("lock-1");
    await expect(token.connect(custodian).mint(user.address, 1000n, lockRef))
      .to.emit(token, "WrappedMinted")
      .withArgs(user.address, 1000n, lockRef);
    expect(await token.balanceOf(user.address)).to.equal(1000n);
    expect(await token.totalSupply()).to.equal(1000n);
  });

  it("rejects mint from a non-custodian", async () => {
    await expect(
      token.connect(other).mint(user.address, 1n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("rejects mint to zero address / zero amount", async () => {
    await expect(
      token.connect(custodian).mint(ethers.ZeroAddress, 1n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(token, "ZeroAddress");
    await expect(
      token.connect(custodian).mint(user.address, 0n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(token, "ZeroAmount");
  });

  it("unwrap burns the caller's supply and emits Unwrapped", async () => {
    await token.connect(custodian).mint(user.address, 500n, ethers.ZeroHash);
    const recRef = ethers.id("dest-addr");
    await expect(token.connect(user).unwrap(200n, recRef))
      .to.emit(token, "Unwrapped")
      .withArgs(user.address, 200n, recRef);
    expect(await token.balanceOf(user.address)).to.equal(300n);
    expect(await token.totalSupply()).to.equal(300n);
  });

  it("unwrap reverts on zero amount and on insufficient balance", async () => {
    await expect(token.connect(user).unwrap(0n, ethers.ZeroHash)).to.be.revertedWithCustomError(
      token,
      "ZeroAmount"
    );
    await expect(
      token.connect(user).unwrap(1n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
  });

  it("exposes ERC20Burnable burn/burnFrom (used by the router pull-then-burn)", async () => {
    await token.connect(custodian).mint(user.address, 100n, ethers.ZeroHash);
    await token.connect(user).burn(40n);
    expect(await token.totalSupply()).to.equal(60n);
    await token.connect(user).approve(other.address, 10n);
    await token.connect(other).burnFrom(user.address, 10n);
    expect(await token.totalSupply()).to.equal(50n);
  });

  it("admin can rotate the custodian role (stage-2 trust posture)", async () => {
    const CUST = await token.CUSTODIAN_ROLE();
    await token.connect(admin).grantRole(CUST, other.address);
    await token.connect(admin).revokeRole(CUST, custodian.address);
    await expect(token.connect(custodian).mint(user.address, 1n, ethers.ZeroHash)).to.be.reverted;
    await expect(token.connect(other).mint(user.address, 1n, ethers.ZeroHash))
      .to.emit(token, "WrappedMinted")
      .withArgs(user.address, 1n, anyValue);
  });
});
