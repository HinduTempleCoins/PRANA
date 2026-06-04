const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("WrappedTokenFactory", function () {
  let factory, admin, custodian, other;
  const melekRef = ethers.id("MELEK");
  const vkbtRef = ethers.id("VKBT");

  beforeEach(async () => {
    [admin, custodian, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("WrappedTokenFactory");
    factory = await F.deploy();
  });

  it("deploys a wrapper, registers it, and emits WrappedCreated", async () => {
    await expect(
      factory.createWrapped("Wrapped MELEK", "wMELEK", 18, melekRef, admin.address, custodian.address)
    )
      .to.emit(factory, "WrappedCreated")
      .withArgs(anyValue, melekRef, "Wrapped MELEK", "wMELEK", 18, admin.address, custodian.address);

    expect(await factory.wrappedCount()).to.equal(1n);
    const addr = await factory.allWrapped(0);
    expect(await factory.wrappedOf(melekRef)).to.equal(addr);

    const t = await ethers.getContractAt("WrappedEcosystemToken", addr);
    expect(await t.symbol()).to.equal("wMELEK");
    expect(await t.originRef()).to.equal(melekRef);
    const CUST = await t.CUSTODIAN_ROLE();
    expect(await t.hasRole(CUST, custodian.address)).to.equal(true);
  });

  it("supports multiple distinct origins and keeps the registry", async () => {
    await factory.createWrapped("Wrapped MELEK", "wMELEK", 18, melekRef, admin.address, custodian.address);
    await factory.createWrapped("Wrapped VKBT", "wVKBT", 8, vkbtRef, admin.address, custodian.address);
    expect(await factory.wrappedCount()).to.equal(2n);
    const a = await ethers.getContractAt("WrappedEcosystemToken", await factory.allWrapped(0));
    const b = await ethers.getContractAt("WrappedEcosystemToken", await factory.allWrapped(1));
    expect(await a.symbol()).to.equal("wMELEK");
    expect(await b.symbol()).to.equal("wVKBT");
    expect(await b.decimals()).to.equal(8);
  });

  it("rejects a duplicate originRef", async () => {
    await factory.createWrapped("Wrapped MELEK", "wMELEK", 18, melekRef, admin.address, custodian.address);
    const existing = await factory.wrappedOf(melekRef);
    await expect(
      factory.createWrapped("Wrapped MELEK 2", "wMELEK2", 18, melekRef, admin.address, custodian.address)
    )
      .to.be.revertedWithCustomError(factory, "OriginAlreadyWrapped")
      .withArgs(melekRef, existing);
  });

  it("deployed wrapper mints only via its custodian", async () => {
    await factory.createWrapped("Wrapped MELEK", "wMELEK", 18, melekRef, admin.address, custodian.address);
    const t = await ethers.getContractAt("WrappedEcosystemToken", await factory.allWrapped(0));
    await expect(t.connect(other).mint(other.address, 1n, ethers.ZeroHash)).to.be.reverted;
    await t.connect(custodian).mint(other.address, 5n, ethers.ZeroHash);
    expect(await t.balanceOf(other.address)).to.equal(5n);
  });
});
