const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

describe("CDPVault (overcollateralized lending)", function () {
  let col, debt, oracle, vault, admin, user, liquidator;

  beforeEach(async () => {
    [admin, user, liquidator] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    col = await Mock.deploy("Collateral", "COL");
    const PoL = await ethers.getContractFactory("PoLToken");
    debt = await PoL.deploy(admin.address);
    const O = await ethers.getContractFactory("SimplePriceOracle");
    oracle = await O.deploy(admin.address);
    const V = await ethers.getContractFactory("CDPVault");
    vault = await V.deploy(await col.getAddress(), await debt.getAddress(), await oracle.getAddress(), WAD / 2n); // 50% LTV
    await debt.grantRole(await debt.MINTER_ROLE(), await vault.getAddress());
    await oracle.setPrice(await col.getAddress(), WAD); // 1:1

    await col.mint(user.address, 1000n);
    await col.connect(user).approve(await vault.getAddress(), 1000n);
  });

  it("borrows up to the LTV and rejects beyond it", async () => {
    await vault.connect(user).deposit(1000n);
    expect(await vault.maxBorrow(user.address)).to.equal(500n);
    await vault.connect(user).borrow(400n);
    expect(await debt.balanceOf(user.address)).to.equal(400n);
    await expect(vault.connect(user).borrow(200n)).to.be.revertedWith("undercollateralized");
  });

  it("repays debt and frees collateral", async () => {
    await vault.connect(user).deposit(1000n);
    await vault.connect(user).borrow(400n);
    await debt.connect(user).approve(await vault.getAddress(), 400n);
    await vault.connect(user).repay(400n);
    expect(await vault.debtOf(user.address)).to.equal(0n);
    await vault.connect(user).withdraw(1000n);
    expect(await col.balanceOf(user.address)).to.equal(1000n);
  });

  it("liquidates an unhealthy position after a price drop", async () => {
    await vault.connect(user).deposit(1000n);
    await vault.connect(user).borrow(400n);
    // price halves -> collateral value 500, maxBorrow 250 < debt 400 -> HF < 1
    await oracle.setPrice(await col.getAddress(), WAD / 2n);
    expect(await vault.healthFactor(user.address)).to.be.lessThan(WAD);

    // liquidator gets debt tokens to repay
    await debt.mint(liquidator.address, 400n);
    await debt.connect(liquidator).approve(await vault.getAddress(), 400n);
    await vault.connect(liquidator).liquidate(user.address);

    expect(await vault.debtOf(user.address)).to.equal(0n);
    expect(await vault.collateralOf(user.address)).to.equal(0n);
    expect(await col.balanceOf(liquidator.address)).to.equal(1000n); // seized
  });
});
