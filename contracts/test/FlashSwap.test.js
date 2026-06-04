const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;

describe("Flash swaps (UniswapV2Pair uniswapV2Call hook)", function () {
  async function fixture() {
    const [deployer, lp] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const tokenA = await Mock.deploy("Token A", "TKA");
    const tokenB = await Mock.deploy("Token B", "TKB");

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(deployer.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    const router = await Router.deploy(await factory.getAddress());

    const liq = ethers.parseEther("100000");
    await tokenA.mint(lp.address, liq);
    await tokenB.mint(lp.address, liq);
    await tokenA.connect(lp).approve(await router.getAddress(), MAX);
    await tokenB.connect(lp).approve(await router.getAddress(), MAX);
    await router
      .connect(lp)
      .addLiquidity(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        liq,
        liq,
        0n,
        0n,
        lp.address,
        DEADLINE
      );

    const factoryAddr = await factory.getAddress();
    const Flash = await ethers.getContractFactory("FlashSwapExample");
    const flash = await Flash.deploy(factoryAddr);

    const Bad = await ethers.getContractFactory("BadFlashBorrower");
    const bad = await Bad.deploy(factoryAddr);

    const pairAddr = await factory.getPair(
      await tokenA.getAddress(),
      await tokenB.getAddress()
    );
    const pair = await ethers.getContractAt("UniswapV2Pair", pairAddr);

    return { factory, tokenA, tokenB, flash, bad, pair, deployer, lp };
  }

  it("a well-behaved borrower repays principal + 0.3% fee and the pair's k grows", async () => {
    const { tokenA, tokenB, flash, pair } = await loadFixture(fixture);

    const borrow = ethers.parseEther("1000");
    // Pre-fund the example with enough tokenA to cover the fee (principal is borrowed/returned).
    await tokenA.mint(await flash.getAddress(), ethers.parseEther("10"));

    const [r0Before, r1Before] = await pair.getReserves();
    const kBefore = r0Before * r1Before;

    await expect(
      flash.startFlashSwap(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        borrow
      )
    ).to.not.be.reverted;

    expect(await flash.flashReceived()).to.equal(true);
    expect(await flash.lastAmountBorrowed()).to.equal(borrow);
    expect(await flash.lastFeePaid()).to.be.greaterThan(0n);

    const [r0After, r1After] = await pair.getReserves();
    expect(r0After * r1After).to.be.greaterThan(kBefore);
  });

  it("reverts the whole tx when the borrower repays nothing (k invariant protects the pool)", async () => {
    const { tokenA, tokenB, bad, pair } = await loadFixture(fixture);
    const borrow = ethers.parseEther("1000");

    const [r0Before, r1Before] = await pair.getReserves();

    await expect(
      bad.startFlashSwap(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        borrow
      )
    ).to.be.reverted; // K (or INSUFFICIENT_INPUT_AMOUNT) — either way no funds escape

    // reserves untouched: the revert rolled back the optimistic transfer
    const [r0After, r1After] = await pair.getReserves();
    expect(r0After).to.equal(r0Before);
    expect(r1After).to.equal(r1Before);
  });

  it("reverts even when the borrower repays a short amount", async () => {
    const { tokenA, tokenB, bad } = await loadFixture(fixture);
    await bad.setRepayShort(true);
    await expect(
      bad.startFlashSwap(
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        ethers.parseEther("1000")
      )
    ).to.be.reverted;
  });
});
