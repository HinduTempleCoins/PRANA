const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

// bytes32 community labels (lowercase address literals are used for accounts elsewhere)
const NAME_A = ethers.encodeBytes32String("MELEK");
const NAME_B = ethers.encodeBytes32String("VKBT");

describe("CrowdStaking (BI11 — NutBox CommunityFi)", function () {
  const EMIT_A = 100n; // reward/block for pool A
  const EMIT_B = 60n; // reward/block for pool B
  const FUND = 10_000_000n; // reward token pre-funded per pool

  async function deployFixture() {
    const [admin, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const power = await Mock.deploy("Power", "PWR");
    const rewardA = await Mock.deploy("RewardA", "RWA");
    const rewardB = await Mock.deploy("RewardB", "RWB");

    const CS = await ethers.getContractFactory("CrowdStaking");
    const cs = await CS.deploy(await power.getAddress(), admin.address);
    const csAddr = await cs.getAddress();

    // Communities pre-fund their reward tokens into the contract.
    await rewardA.mint(csAddr, FUND);
    await rewardB.mint(csAddr, FUND);

    // Stakers get power tokens + approve the contract.
    for (const u of [alice, bob, carol]) {
      await power.mint(u.address, 1_000_000n);
      await power.connect(u).approve(csAddr, ethers.MaxUint256);
    }

    return { cs, csAddr, power, rewardA, rewardB, admin, alice, bob, carol };
  }

  async function withTwoPools() {
    const ctx = await deployFixture();
    await ctx.cs.addPool(await ctx.rewardA.getAddress(), EMIT_A, NAME_A); // pid 0
    await ctx.cs.addPool(await ctx.rewardB.getAddress(), EMIT_B, NAME_B); // pid 1
    return ctx;
  }

  it("deploys with the shared power token configured", async () => {
    const { cs, power } = await loadFixture(deployFixture);
    expect(await cs.powerToken()).to.equal(await power.getAddress());
    expect(await cs.poolCount()).to.equal(0n);
  });

  describe("pool registry / admin", () => {
    it("only owner can add a pool, emits PoolAdded, increments count", async () => {
      const { cs, rewardA, alice } = await loadFixture(deployFixture);
      const ra = await rewardA.getAddress();

      await expect(cs.connect(alice).addPool(ra, EMIT_A, NAME_A)).to.be.revertedWithCustomError(
        cs,
        "OwnableUnauthorizedAccount"
      );

      await expect(cs.addPool(ra, EMIT_A, NAME_A))
        .to.emit(cs, "PoolAdded")
        .withArgs(0n, ra, EMIT_A, NAME_A);
      expect(await cs.poolCount()).to.equal(1n);

      const p = await cs.pools(0n);
      expect(p.rewardToken).to.equal(ra);
      expect(p.emissionPerBlock).to.equal(EMIT_A);
      expect(p.name).to.equal(NAME_A);
      expect(p.exists).to.equal(true);
    });

    it("rejects zero reward token / zero emission", async () => {
      const { cs, rewardA } = await loadFixture(deployFixture);
      await expect(
        cs.addPool(ethers.ZeroAddress, EMIT_A, NAME_A)
      ).to.be.revertedWithCustomError(cs, "ZeroAddress");
      await expect(
        cs.addPool(await rewardA.getAddress(), 0n, NAME_A)
      ).to.be.revertedWithCustomError(cs, "ZeroAmount");
    });

    it("reverts on an unknown pool id", async () => {
      const { cs, alice } = await loadFixture(deployFixture);
      await expect(cs.connect(alice).stake(0n, 1n)).to.be.revertedWithCustomError(cs, "UnknownPool");
      await expect(cs.pendingReward(5n, alice.address)).to.be.revertedWithCustomError(
        cs,
        "UnknownPool"
      );
    });
  });

  describe("stake / accrue / harvest", () => {
    it("reverts staking zero", async () => {
      const { cs, alice } = await loadFixture(withTwoPools);
      await expect(cs.connect(alice).stake(0n, 0n)).to.be.revertedWithCustomError(cs, "ZeroAmount");
    });

    it("stake pulls the power token and tracks weight", async () => {
      const { cs, csAddr, power, alice } = await loadFixture(withTwoPools);
      await expect(cs.connect(alice).stake(0n, 1000n))
        .to.emit(cs, "Staked")
        .withArgs(0n, alice.address, 1000n, 1000n);

      expect(await cs.stakedOf(0n, alice.address)).to.equal(1000n);
      const p = await cs.pools(0n);
      expect(p.totalStaked).to.equal(1000n);
      expect(await power.balanceOf(csAddr)).to.equal(1000n);
    });

    it("sole staker accrues one full emission per block", async () => {
      const { cs, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await mine(5);
      expect(await cs.pendingReward(0n, alice.address)).to.equal(5n * EMIT_A);
    });

    it("harvest transfers the community reward token and zeroes pending", async () => {
      const { cs, rewardA, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await mine(3);
      expect(await cs.pendingReward(0n, alice.address)).to.equal(3n * EMIT_A);

      // harvest mines a block -> 4 blocks accrued
      await expect(cs.connect(alice).harvest(0n))
        .to.emit(cs, "Harvested")
        .withArgs(0n, alice.address, 4n * EMIT_A);
      expect(await rewardA.balanceOf(alice.address)).to.equal(4n * EMIT_A);
      expect(await cs.pendingReward(0n, alice.address)).to.equal(0n);
    });

    it("harvest with nothing staked pays zero", async () => {
      const { cs, rewardA, carol } = await loadFixture(withTwoPools);
      await cs.connect(carol).harvest(0n);
      expect(await rewardA.balanceOf(carol.address)).to.equal(0n);
    });
  });

  describe("pro-rata split across two stakers", () => {
    it("splits emission by share of the pool", async () => {
      const { cs, alice, bob } = await loadFixture(withTwoPools);
      // alice stakes, then bob stakes (alice earns 1 solo block during bob's stake tx)
      await cs.connect(alice).stake(0n, 1000n);
      await cs.connect(bob).stake(0n, 3000n);

      const aBefore = await cs.pendingReward(0n, alice.address);
      await mine(10); // both active: alice 1/4, bob 3/4 of 10*100 = 1000
      const aGain = (await cs.pendingReward(0n, alice.address)) - aBefore;
      const bTotal = await cs.pendingReward(0n, bob.address);

      expect(aGain).to.equal(250n);
      expect(bTotal).to.equal(750n);
    });
  });

  describe("unstake", () => {
    it("returns principal and drops weight immediately", async () => {
      const { cs, power, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await mine(2);

      const balBefore = await power.balanceOf(alice.address);
      await expect(cs.connect(alice).unstake(0n, 400n))
        .to.emit(cs, "Unstaked")
        .withArgs(0n, alice.address, 400n, 600n);

      expect(await cs.stakedOf(0n, alice.address)).to.equal(600n);
      const p = await cs.pools(0n);
      expect(p.totalStaked).to.equal(600n);
      expect(await power.balanceOf(alice.address)).to.equal(balBefore + 400n);
    });

    it("reverts unstaking zero or more than staked", async () => {
      const { cs, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await expect(cs.connect(alice).unstake(0n, 0n)).to.be.revertedWithCustomError(cs, "ZeroAmount");
      await expect(cs.connect(alice).unstake(0n, 1001n)).to.be.revertedWithCustomError(
        cs,
        "InsufficientStake"
      );
    });

    it("harvest-then-unstake: full exit then harvest pays the right amount", async () => {
      const { cs, rewardA, power, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await mine(4);

      // full exit (mines a block -> 5 accrued, preserved as pending)
      await cs.connect(alice).unstake(0n, 1000n);
      expect(await cs.stakedOf(0n, alice.address)).to.equal(0n);
      expect(await power.balanceOf(alice.address)).to.equal(1_000_000n);

      await cs.connect(alice).harvest(0n);
      expect(await rewardA.balanceOf(alice.address)).to.equal(5n * EMIT_A);
    });

    it("harvest-then-unstake: harvest first, then unstake returns principal", async () => {
      const { cs, rewardA, power, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await mine(3);

      await cs.connect(alice).harvest(0n); // 4 blocks -> 400
      expect(await rewardA.balanceOf(alice.address)).to.equal(4n * EMIT_A);

      await cs.connect(alice).unstake(0n, 1000n); // 1 more block accrues -> 100 pending
      expect(await power.balanceOf(alice.address)).to.equal(1_000_000n);

      await cs.connect(alice).harvest(0n);
      expect(await rewardA.balanceOf(alice.address)).to.equal(5n * EMIT_A);
    });
  });

  describe("multiple pools are independent", () => {
    it("a staker in pool A earns only rewardA; pool B is unaffected", async () => {
      const { cs, rewardA, rewardB, alice, bob } = await loadFixture(withTwoPools);

      await cs.connect(alice).stake(0n, 1000n); // pool A — alice's accrual starts here (block S)
      await cs.connect(bob).stake(1n, 1000n); // pool B — mines a block: pool A is now at S+1
      await mine(10); // now at S+11

      // pool A pays EMIT_A/block, pool B pays EMIT_B/block — fully separate accounting.
      // Alice accrues from her stake block S to now (S+11) = 11 blocks. (bob's stake on pool B
      // still mines a block that advances pool A's clock, since pool A already had stake.)
      expect(await cs.pendingReward(0n, alice.address)).to.equal(11n * EMIT_A);
      // Bob staked one block later (S+1), so 10 blocks elapsed for him.
      expect(await cs.pendingReward(1n, bob.address)).to.equal(10n * EMIT_B);
      // cross-pool: alice has nothing in B, bob nothing in A
      expect(await cs.pendingReward(1n, alice.address)).to.equal(0n);
      expect(await cs.pendingReward(0n, bob.address)).to.equal(0n);

      await cs.connect(alice).harvest(0n); // mines a block: alice settled at S+12 -> 12 blocks
      await cs.connect(bob).harvest(1n); // mines a block: bob settled at S+13 -> 12 blocks since S+1
      expect(await rewardA.balanceOf(alice.address)).to.equal(12n * EMIT_A);
      expect(await rewardB.balanceOf(bob.address)).to.equal(12n * EMIT_B);
      // no cross-contamination of reward tokens
      expect(await rewardB.balanceOf(alice.address)).to.equal(0n);
      expect(await rewardA.balanceOf(bob.address)).to.equal(0n);
    });

    it("same staker can hold positions in both pools simultaneously", async () => {
      const { cs, rewardA, rewardB, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);
      await cs.connect(alice).stake(1n, 2000n);
      await mine(5);
      expect(await cs.pendingReward(0n, alice.address)).to.be.greaterThan(0n);
      expect(await cs.pendingReward(1n, alice.address)).to.be.greaterThan(0n);

      await cs.connect(alice).harvest(0n);
      await cs.connect(alice).harvest(1n);
      expect(await rewardA.balanceOf(alice.address)).to.be.greaterThan(0n);
      expect(await rewardB.balanceOf(alice.address)).to.be.greaterThan(0n);
    });
  });

  describe("emission rate change (DAO knob)", () => {
    it("only owner; settles at old rate, then applies new rate going forward", async () => {
      const { cs, alice } = await loadFixture(withTwoPools);
      await cs.connect(alice).stake(0n, 1000n);

      // Each of these two reverting txs is still mined into its own block under hardhat's
      // automine, so they advance pool A's accrual clock by 2 blocks before we mine(5) below.
      await expect(cs.connect(alice).setEmissionRate(0n, 200n)).to.be.revertedWithCustomError(
        cs,
        "OwnableUnauthorizedAccount"
      ); // +1 block
      await expect(cs.setEmissionRate(0n, 0n)).to.be.revertedWithCustomError(cs, "ZeroAmount"); // +1 block

      // mine some blocks at the old rate, then bump
      await mine(5);
      // Alice has accrued over 7 blocks since her stake: 2 from the reverting txs + 5 mined.
      const beforeBump = await cs.pendingReward(0n, alice.address); // 7 blocks @100 (view, pre-tx)

      // setEmissionRate mines a block: that block accrues at OLD rate (100) before switching
      await expect(cs.setEmissionRate(0n, 200n))
        .to.emit(cs, "EmissionRateChanged")
        .withArgs(0n, EMIT_A, 200n);
      expect(beforeBump).to.equal(7n * EMIT_A);

      const atBump = await cs.pendingReward(0n, alice.address); // 8 blocks @100 (the bump tx settled at old rate)
      expect(atBump).to.equal(8n * EMIT_A);

      await mine(4); // 4 blocks @ new 200
      const after = await cs.pendingReward(0n, alice.address);
      expect(after).to.equal(8n * EMIT_A + 4n * 200n);
    });
  });

  describe("idle blocks", () => {
    it("blocks with zero total stake are not back-paid", async () => {
      const { cs, alice } = await loadFixture(withTwoPools);
      await mine(20); // nothing staked
      await cs.connect(alice).stake(0n, 1000n);
      await mine(3);
      expect(await cs.pendingReward(0n, alice.address)).to.equal(3n * EMIT_A);
    });
  });

  describe("graceful degradation when under-funded", () => {
    it("pays at most the contract's reward-token balance and keeps the remainder pending", async () => {
      const { cs, csAddr, rewardA, alice } = await loadFixture(deployFixture);
      // tiny-funded pool: only 250 rewardA available
      const small = await (await ethers.getContractFactory("MockERC20")).deploy("Small", "SML");
      await small.mint(csAddr, 250n);
      await cs.addPool(await small.getAddress(), 100n, NAME_A); // pid 0

      await cs.connect(alice).stake(0n, 1000n);
      await mine(5); // 500 owed, only 250 funded

      await cs.connect(alice).harvest(0n); // pays 250, ~350 remains owed (6 blocks at harvest)
      expect(await small.balanceOf(alice.address)).to.equal(250n);
      expect(await cs.pendingReward(0n, alice.address)).to.be.greaterThan(0n);
    });
  });
});
