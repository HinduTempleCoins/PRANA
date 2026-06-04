const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenLaunchpad", function () {
  const CAP = ethers.parseEther("1000000");
  const TOKEN_LIQ = ethers.parseEther("100000");
  const COUNTER_LIQ = ethers.parseEther("50000");
  const MAX = ethers.MaxUint256;
  const MINIMUM_LIQUIDITY = 1000n;

  function isqrt(value) {
    if (value < 2n) return value;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }
    return x;
  }

  async function deployFixture() {
    const [deployer, creator, trader] = await ethers.getSigners();

    const Wizard = await ethers.getContractFactory("ERC20FactoryWizard");
    const wizard = await Wizard.deploy();

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(deployer.address);

    const Router = await ethers.getContractFactory("UniswapV2Router");
    const router = await Router.deploy(await factory.getAddress());

    const Locker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await Locker.deploy();

    const Launchpad = await ethers.getContractFactory("TokenLaunchpad");
    const launchpad = await Launchpad.deploy(
      await wizard.getAddress(),
      await router.getAddress(),
      await locker.getAddress()
    );

    // Counter asset (e.g. a base/quote token) held by the creator.
    const Mock = await ethers.getContractFactory("MockERC20");
    const counter = await Mock.deploy("Counter", "CTR");
    await counter.mint(creator.address, ethers.parseEther("10000000"));
    await counter
      .connect(creator)
      .approve(await launchpad.getAddress(), MAX);

    return { deployer, creator, trader, wizard, factory, router, locker, launchpad, counter };
  }

  function params(lockUntil = 0) {
    return {
      name: "Launch Token",
      symbol: "LTK",
      cap: CAP,
      lockUntil,
    };
  }

  it("launches token + pair + seeded reserves in one tx; LP to caller", async function () {
    const { creator, factory, launchpad, counter } = await loadFixture(deployFixture);

    const tx = await launchpad
      .connect(creator)
      .createTokenWithPool(params(0), await counter.getAddress(), TOKEN_LIQ, COUNTER_LIQ);
    const rcpt = await tx.wait();

    // Decode the TokenLaunched event.
    const ev = rcpt.logs
      .map((l) => {
        try {
          return launchpad.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "TokenLaunched");
    expect(ev, "TokenLaunched emitted").to.not.equal(undefined);

    const token = ev.args.token;
    const pair = ev.args.pair;
    const liquidity = ev.args.liquidity;
    expect(ev.args.creator).to.equal(creator.address);
    expect(ev.args.locked).to.equal(false);

    // Pair registered on the factory.
    expect(await factory.getPair(token, await counter.getAddress())).to.equal(pair);

    // Reserves seeded with exactly the supplied amounts.
    const pairC = await ethers.getContractAt("UniswapV2Pair", pair);
    const tokenC = await ethers.getContractAt("ERC20Base", token);
    const [r0, r1] = await pairC.getReserves();
    const t0 = await pairC.token0();
    const tokenIs0 = BigInt(token) < BigInt(await counter.getAddress());
    const tokenReserve = tokenIs0 ? r0 : r1;
    const counterReserve = tokenIs0 ? r1 : r0;
    expect(t0).to.equal(tokenIs0 ? token : (await counter.getAddress()));
    expect(tokenReserve).to.equal(TOKEN_LIQ);
    expect(counterReserve).to.equal(COUNTER_LIQ);

    // LP minted to the creator (minus the permanently-locked minimum).
    const expectedLP = isqrt(TOKEN_LIQ * COUNTER_LIQ) - MINIMUM_LIQUIDITY;
    expect(liquidity).to.equal(expectedLP);
    expect(await pairC.balanceOf(creator.address)).to.equal(expectedLP);

    // Launchpad holds no leftover token/LP dust.
    expect(await tokenC.balanceOf(await launchpad.getAddress())).to.equal(0n);
    expect(await pairC.balanceOf(await launchpad.getAddress())).to.equal(0n);
  });

  it("the new pool is immediately swappable", async function () {
    const { creator, trader, router, factory, launchpad, counter } =
      await loadFixture(deployFixture);

    const tx = await launchpad
      .connect(creator)
      .createTokenWithPool(params(0), await counter.getAddress(), TOKEN_LIQ, COUNTER_LIQ);
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l) => {
        try {
          return launchpad.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "TokenLaunched");
    const token = ev.args.token;

    // Trader swaps counter -> new token.
    const amountIn = ethers.parseEther("1000");
    await counter.mint(trader.address, amountIn);
    await counter.connect(trader).approve(await router.getAddress(), MAX);

    const path = [await counter.getAddress(), token];
    const outs = await router.getAmountsOut(amountIn, path);
    const predicted = outs[1];
    expect(predicted).to.be.greaterThan(0n);

    const tokenC = await ethers.getContractAt("ERC20Base", token);
    const before = await tokenC.balanceOf(trader.address);
    await router
      .connect(trader)
      .swapExactTokensForTokens(amountIn, 0n, path, trader.address, 2_000_000_000n);
    const received = (await tokenC.balanceOf(trader.address)) - before;
    expect(received).to.equal(predicted);
  });

  it("optional-lock path: LP is time-locked for the caller instead of sent", async function () {
    const { creator, locker, launchpad, counter } = await loadFixture(deployFixture);

    const unlockAt = (await time.latest()) + 3600;
    const tx = await launchpad
      .connect(creator)
      .createTokenWithPool(
        params(unlockAt),
        await counter.getAddress(),
        TOKEN_LIQ,
        COUNTER_LIQ
      );
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l) => {
        try {
          return launchpad.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "TokenLaunched");

    expect(ev.args.locked).to.equal(true);
    const pairC = await ethers.getContractAt("UniswapV2Pair", ev.args.pair);

    // LP sits in the locker, not with the creator.
    expect(await pairC.balanceOf(creator.address)).to.equal(0n);
    expect(await pairC.balanceOf(await locker.getAddress())).to.equal(ev.args.liquidity);

    // The lock is owned by the creator and matures at unlockAt.
    const [lockTok, lockOwner, lockAmt, lockUnlock] = await locker.getLock(ev.args.lockId);
    expect(lockTok).to.equal(ev.args.pair);
    expect(lockOwner).to.equal(creator.address);
    expect(lockAmt).to.equal(ev.args.liquidity);
    expect(lockUnlock).to.equal(BigInt(unlockAt));
  });

  it("reverts on zero token liquidity", async function () {
    const { creator, launchpad, counter } = await loadFixture(deployFixture);
    await expect(
      launchpad
        .connect(creator)
        .createTokenWithPool(params(0), await counter.getAddress(), 0n, COUNTER_LIQ)
    ).to.be.revertedWithCustomError(launchpad, "ZeroTokenLiquidity");
  });

  it("reverts on zero counter liquidity", async function () {
    const { creator, launchpad, counter } = await loadFixture(deployFixture);
    await expect(
      launchpad
        .connect(creator)
        .createTokenWithPool(params(0), await counter.getAddress(), TOKEN_LIQ, 0n)
    ).to.be.revertedWithCustomError(launchpad, "ZeroCounterLiquidity");
  });

  it("reverts when the cap is below the seeded token liquidity", async function () {
    const { creator, launchpad, counter } = await loadFixture(deployFixture);
    const p = params(0);
    p.cap = TOKEN_LIQ - 1n;
    await expect(
      launchpad
        .connect(creator)
        .createTokenWithPool(p, await counter.getAddress(), TOKEN_LIQ, COUNTER_LIQ)
    ).to.be.revertedWithCustomError(launchpad, "CapBelowLiquidity");
  });

  it("reverts when an unlock time is requested in the past", async function () {
    const { creator, launchpad, counter } = await loadFixture(deployFixture);
    const past = (await time.latest()) - 1;
    await expect(
      launchpad
        .connect(creator)
        .createTokenWithPool(
          params(past),
          await counter.getAddress(),
          TOKEN_LIQ,
          COUNTER_LIQ
        )
    ).to.be.revertedWithCustomError(launchpad, "LockInPast");
  });
});
