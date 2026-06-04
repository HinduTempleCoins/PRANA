const { expect } = require("chai");
const { ethers } = require("hardhat");

// Far-future deadline so the router's `ensure` modifier never trips.
const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;

// Mode enum: 0 = Burn, 1 = Distribute
const MODE_BURN = 0;
const MODE_DISTRIBUTE = 1;

// lowercase plain address literal for the community recipient sink
const COMMUNITY_RECIPIENT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

describe("CommunityBuybackVault", function () {
  let factory, router, tokenIn, tokenOut, vault;
  let admin, keeper, lp, outsider;

  // deep pool so the buyback has low slippage and predictable output
  const LIQ_IN = ethers.parseEther("100000"); // tokenIn reserve
  const LIQ_OUT = ethers.parseEther("100000"); // tokenOut reserve
  const REWARD_INFLOW = ethers.parseEther("1000"); // curation rewards accrued to the vault

  async function deployVault(mode, recipient) {
    const Vault = await ethers.getContractFactory("CommunityBuybackVault");
    return Vault.deploy(
      admin.address,
      keeper.address,
      await router.getAddress(),
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      mode,
      recipient
    );
  }

  beforeEach(async () => {
    [admin, keeper, lp, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    tokenIn = await Mock.deploy("Reward Token A", "TKA");
    tokenOut = await Mock.deploy("Buyback Token B", "TKB");

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    factory = await Factory.deploy(admin.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    router = await Router.deploy(await factory.getAddress());

    // seed a deep tokenIn/tokenOut pool
    await tokenIn.mint(lp.address, LIQ_IN);
    await tokenOut.mint(lp.address, LIQ_OUT);
    await tokenIn.connect(lp).approve(await router.getAddress(), MAX);
    await tokenOut.connect(lp).approve(await router.getAddress(), MAX);
    await router
      .connect(lp)
      .addLiquidity(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        LIQ_IN,
        LIQ_OUT,
        0n,
        0n,
        lp.address,
        DEADLINE
      );
  });

  it("buyback-and-burn: swaps the inflow for tokenOut and burns it", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);

    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    const expectedOut = await vault.quoteBuyback(path);
    expect(expectedOut).to.be.greaterThan(0n);

    const supplyBefore = await tokenOut.totalSupply();

    await expect(vault.connect(keeper).buyback(path, expectedOut, DEADLINE))
      .to.emit(vault, "Burned")
      .withArgs(expectedOut)
      .and.to.emit(vault, "Buyback")
      .withArgs(keeper.address, REWARD_INFLOW, expectedOut, MODE_BURN);

    // the bought tokenOut was burned, not held
    expect(await tokenOut.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await tokenOut.totalSupply()).to.equal(supplyBefore - expectedOut);
    // the inflow was fully spent
    expect(await tokenIn.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("buyback-and-distribute: swaps the inflow and sends tokenOut to the community recipient", async () => {
    vault = await deployVault(MODE_DISTRIBUTE, COMMUNITY_RECIPIENT);
    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);

    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    const expectedOut = await vault.quoteBuyback(path);

    await expect(vault.connect(keeper).buyback(path, expectedOut, DEADLINE))
      .to.emit(vault, "Distributed")
      .withArgs(ethers.getAddress(COMMUNITY_RECIPIENT), expectedOut);

    expect(await tokenOut.balanceOf(COMMUNITY_RECIPIENT)).to.equal(expectedOut);
    expect(await tokenIn.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("reverts when the slippage guard (minOut) is not met", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);

    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    const expectedOut = await vault.quoteBuyback(path);

    // demand more than the pool can deliver → router reverts on the slippage check
    await expect(
      vault.connect(keeper).buyback(path, expectedOut + 1n, DEADLINE)
    ).to.be.revertedWith("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
  });

  it("only KEEPER_ROLE can trigger the buyback", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);

    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    await expect(
      vault.connect(outsider).buyback(path, 0n, DEADLINE)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("reverts buyback when there is nothing to spend", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    await expect(
      vault.connect(keeper).buyback(path, 0n, DEADLINE)
    ).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("rejects a path that does not start at tokenIn / end at tokenOut", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);
    // reversed path
    const badPath = [await tokenOut.getAddress(), await tokenIn.getAddress()];
    await expect(
      vault.connect(keeper).buyback(badPath, 0n, DEADLINE)
    ).to.be.revertedWithCustomError(vault, "ZeroAddress");
  });

  it("admin can flip the mode and the next buyback follows it", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await expect(vault.connect(admin).setMode(MODE_DISTRIBUTE))
      .to.emit(vault, "ModeSet")
      .withArgs(MODE_DISTRIBUTE);
    await vault.connect(admin).setCommunityRecipient(COMMUNITY_RECIPIENT);

    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);
    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];
    const expectedOut = await vault.quoteBuyback(path);
    await vault.connect(keeper).buyback(path, expectedOut, DEADLINE);
    expect(await tokenOut.balanceOf(COMMUNITY_RECIPIENT)).to.equal(expectedOut);
  });

  it("admin can rotate the keeper role", async () => {
    vault = await deployVault(MODE_BURN, ethers.ZeroAddress);
    await vault.connect(admin).setKeeper(outsider.address, true);
    await vault.connect(admin).setKeeper(keeper.address, false);

    await tokenIn.mint(await vault.getAddress(), REWARD_INFLOW);
    const path = [await tokenIn.getAddress(), await tokenOut.getAddress()];

    // old keeper now rejected
    await expect(
      vault.connect(keeper).buyback(path, 0n, DEADLINE)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

    // new keeper works
    const expectedOut = await vault.quoteBuyback(path);
    await expect(vault.connect(outsider).buyback(path, expectedOut, DEADLINE)).to.emit(
      vault,
      "Buyback"
    );
  });
});
