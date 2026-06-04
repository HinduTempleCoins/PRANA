const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const DEADLINE = 2_000_000_000n;
const MAX = ethers.MaxUint256;

describe("LPGaugeAdapter — stake V2 LP into a LiquidityGauge", function () {
  async function fixture() {
    const [deployer, lp, distributor] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const tokenA = await Mock.deploy("Token A", "TKA");
    const tokenB = await Mock.deploy("Token B", "TKB");
    const reward = await Mock.deploy("Reward", "REW");

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(deployer.address);
    const Router = await ethers.getContractFactory("UniswapV2Router");
    const router = await Router.deploy(await factory.getAddress());

    // Give the LP a real V2 LP-token position.
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

    const pairAddr = await factory.getPair(
      await tokenA.getAddress(),
      await tokenB.getAddress()
    );
    const lpToken = await ethers.getContractAt("UniswapV2Pair", pairAddr);

    // Gauge stakes the LP token, streams `reward`.
    const Gauge = await ethers.getContractFactory("LiquidityGauge");
    const gauge = await Gauge.deploy(pairAddr, await reward.getAddress(), distributor.address);

    const Adapter = await ethers.getContractFactory("LPGaugeAdapter");
    const adapter = await Adapter.deploy(await gauge.getAddress());

    // Fund the reward stream.
    await reward.mint(distributor.address, ethers.parseEther("10000"));
    await reward
      .connect(distributor)
      .approve(await gauge.getAddress(), MAX);

    return { lpToken, gauge, adapter, reward, lp, distributor };
  }

  it("wires the adapter to the gauge's stake and reward tokens", async () => {
    const { adapter, gauge, lpToken, reward } = await loadFixture(fixture);
    expect(await adapter.lpToken()).to.equal(await lpToken.getAddress());
    expect(await adapter.rewardToken()).to.equal(await reward.getAddress());
    expect(await adapter.gauge()).to.equal(await gauge.getAddress());
  });

  it("deposit -> earn -> claim -> withdraw lifecycle", async () => {
    const { lpToken, gauge, adapter, reward, lp, distributor } = await loadFixture(fixture);

    const lpBal = await lpToken.balanceOf(lp.address);
    expect(lpBal).to.be.greaterThan(0n);

    // deposit: user approves the adapter, adapter stakes into the gauge on user's behalf
    await lpToken.connect(lp).approve(await adapter.getAddress(), MAX);
    await adapter.connect(lp).deposit(lpBal);

    expect(await adapter.staked(lp.address)).to.equal(lpBal);
    expect(await adapter.totalStaked()).to.equal(lpBal);
    // the adapter holds the gauge position
    expect(await gauge.balanceOf(await adapter.getAddress())).to.equal(lpBal);
    // user's LP is gone (now staked through the adapter)
    expect(await lpToken.balanceOf(lp.address)).to.equal(0n);

    // start the reward stream and let time pass
    const REWARD = ethers.parseEther("1000");
    const DURATION = 1000;
    await gauge.connect(distributor).notifyRewardAmount(REWARD, DURATION);
    await time.increase(500);

    expect(await adapter.earned()).to.be.greaterThan(0n);

    // claim: rewards flow adapter -> user
    const rBefore = await reward.balanceOf(lp.address);
    await adapter.connect(lp).claim();
    const claimed = (await reward.balanceOf(lp.address)) - rBefore;
    expect(claimed).to.be.greaterThan(0n);

    // withdraw: LP comes back to the user
    await adapter.connect(lp).withdraw(lpBal);
    expect(await adapter.staked(lp.address)).to.equal(0n);
    expect(await adapter.totalStaked()).to.equal(0n);
    expect(await lpToken.balanceOf(lp.address)).to.equal(lpBal);
  });

  it("exit() claims rewards and withdraws all staked LP", async () => {
    const { lpToken, gauge, adapter, reward, lp, distributor } = await loadFixture(fixture);
    const lpBal = await lpToken.balanceOf(lp.address);
    await lpToken.connect(lp).approve(await adapter.getAddress(), MAX);
    await adapter.connect(lp).deposit(lpBal);

    await gauge.connect(distributor).notifyRewardAmount(ethers.parseEther("1000"), 1000);
    await time.increase(1000); // full period

    const rBefore = await reward.balanceOf(lp.address);
    await adapter.connect(lp).exit();

    expect(await adapter.staked(lp.address)).to.equal(0n);
    expect(await lpToken.balanceOf(lp.address)).to.equal(lpBal);
    expect((await reward.balanceOf(lp.address)) - rBefore).to.be.greaterThan(0n);
  });

  it("reverts on zero deposit and on over-withdraw", async () => {
    const { lpToken, adapter, lp } = await loadFixture(fixture);
    const lpBal = await lpToken.balanceOf(lp.address);
    await lpToken.connect(lp).approve(await adapter.getAddress(), MAX);

    await expect(adapter.connect(lp).deposit(0n)).to.be.revertedWith("amount=0");
    await adapter.connect(lp).deposit(lpBal);
    await expect(adapter.connect(lp).withdraw(lpBal + 1n)).to.be.revertedWith("bad amount");
  });
});
