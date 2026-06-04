const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VestingFactory", function () {
  const TOTAL = ethers.parseEther("1000");
  const CLIFF = 0n;
  const DURATION = 1000n; // seconds

  async function deploy() {
    const [deployer, beneficiary, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock", "MOCK");
    await token.mint(deployer.address, TOTAL * 10n);

    const VestingFactory = await ethers.getContractFactory("VestingFactory");
    const factory = await VestingFactory.deploy();

    const start = BigInt(await time.latest()) + 10n;

    return { deployer, beneficiary, other, token, factory, start };
  }

  async function createOne(ctx, overrides = {}) {
    const { deployer, beneficiary, token, factory, start } = ctx;
    const beny = overrides.beneficiary ?? beneficiary.address;
    await token.connect(deployer).approve(factory.target, TOTAL);
    const tx = await factory
      .connect(deployer)
      .createVesting(token.target, beny, start, CLIFF, DURATION, TOTAL);
    const receipt = await tx.wait();

    // Pull the deployed child address out of the VestingCreated event.
    const ev = receipt.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "VestingCreated");
    expect(ev, "VestingCreated emitted").to.not.equal(null);

    const vesting = await ethers.getContractAt("TokenVesting", ev.args.vesting);
    return { vesting, start };
  }

  it("createVesting deploys a vesting contract holding `total`", async function () {
    const ctx = await deploy();
    const { vesting } = await createOne(ctx);

    expect(await ctx.token.balanceOf(vesting.target)).to.equal(TOTAL);
    expect(await vesting.beneficiary()).to.equal(ctx.beneficiary.address);
    expect(await vesting.total()).to.equal(TOTAL);
    expect(await ctx.factory.allVestingsLength()).to.equal(1n);
  });

  it("beneficiary can release linearly over time", async function () {
    const ctx = await deploy();
    const { vesting, start } = await createOne(ctx);

    // Jump to the midpoint of the vesting schedule (~50% vested).
    await time.increaseTo(start + DURATION / 2n);
    const releasableMid = await vesting.releasable();
    expect(releasableMid).to.be.greaterThan(0n);
    expect(releasableMid).to.be.closeTo(TOTAL / 2n, ethers.parseEther("5"));

    await vesting.connect(ctx.beneficiary).release();
    expect(await ctx.token.balanceOf(ctx.beneficiary.address)).to.be.closeTo(
      TOTAL / 2n,
      ethers.parseEther("5")
    );

    // After the full duration the rest is claimable.
    await time.increaseTo(start + DURATION + 1n);
    await vesting.connect(ctx.beneficiary).release();
    expect(await ctx.token.balanceOf(ctx.beneficiary.address)).to.equal(TOTAL);
    expect(await ctx.token.balanceOf(vesting.target)).to.equal(0n);
  });

  it("tracks vestings per beneficiary", async function () {
    const ctx = await deploy();
    const { vesting: v1 } = await createOne(ctx);
    const { vesting: v2 } = await createOne(ctx);

    expect(await ctx.factory.vestingsOfLength(ctx.beneficiary.address)).to.equal(2n);
    expect(await ctx.factory.vestingsOf(ctx.beneficiary.address, 0)).to.equal(v1.target);
    expect(await ctx.factory.vestingsOf(ctx.beneficiary.address, 1)).to.equal(v2.target);

    // A different beneficiary has its own (empty) list.
    expect(await ctx.factory.vestingsOfLength(ctx.other.address)).to.equal(0n);
  });

  it("createVesting reverts without approval", async function () {
    const ctx = await deploy();
    // No approve() call here.
    await expect(
      ctx.factory
        .connect(ctx.deployer)
        .createVesting(
          ctx.token.target,
          ctx.beneficiary.address,
          ctx.start,
          CLIFF,
          DURATION,
          TOTAL
        )
    ).to.be.reverted;
  });
});
