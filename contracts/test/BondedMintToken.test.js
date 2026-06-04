const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const EPOCH_LEN = 7 * 24 * 60 * 60; // 1 week
const BASE_EMISSION = ethers.parseEther("1000");
const DECAY_BPS = 1000n; // 10% decay per epoch
const MAX_LOCK = 4n * 365n * 24n * 60n * 60n; // ~4 years

describe("BondedMintToken", function () {
  // ---- VoteEscrow-source fixture ----
  async function veFixture() {
    const [admin, a, b, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const stake = await Mock.deploy("Stake", "STK");

    const VE = await ethers.getContractFactory("VoteEscrow");
    const ve = await VE.deploy(await stake.getAddress(), MAX_LOCK);

    const Src = await ethers.getContractFactory("VoteEscrowWeightSource");
    const src = await Src.deploy(await ve.getAddress());

    const Bonded = await ethers.getContractFactory("BondedMintToken");
    const bonded = await Bonded.deploy(
      "Bonded", "BND", await src.getAddress(), EPOCH_LEN, BASE_EMISSION, DECAY_BPS
    );

    // a and b lock; a locks twice b's amount for a known 2:1 weight ratio (same duration).
    for (const [who, amt] of [[a, ethers.parseEther("200")], [b, ethers.parseEther("100")]]) {
      await stake.mint(who.address, amt);
      await stake.connect(who).approve(await ve.getAddress(), amt);
      await ve.connect(who).lock(amt, MAX_LOCK);
    }

    return { bonded, ve, stake, src, admin, a, b, other };
  }

  // ---- StakeLock-source fixture ----
  async function stakeLockFixture() {
    const [admin, a, b, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const lockTok = await Mock.deploy("Lock", "LCK");

    const SL = await ethers.getContractFactory("StakeLock");
    const sl = await SL.deploy(await lockTok.getAddress(), admin.address);
    const DUR = MAX_LOCK;
    await sl.setTier(DUR, 10000n); // 1x multiplier

    const Src = await ethers.getContractFactory("StakeLockWeightSource");
    const src = await Src.deploy(await sl.getAddress());

    const Bonded = await ethers.getContractFactory("BondedMintToken");
    const bonded = await Bonded.deploy(
      "Bonded", "BND", await src.getAddress(), EPOCH_LEN, BASE_EMISSION, DECAY_BPS
    );

    for (const [who, amt] of [[a, ethers.parseEther("200")], [b, ethers.parseEther("100")]]) {
      await lockTok.mint(who.address, amt);
      await lockTok.connect(who).approve(await sl.getAddress(), amt);
      await sl.connect(who).lock(amt, DUR);
    }

    return { bonded, sl, src, admin, a, b, other };
  }

  describe("register / claim with VoteEscrow source", function () {
    it("distributes the epoch emission pro-rata to registered weight", async () => {
      const { bonded, a, b } = await loadFixture(veFixture);
      const epoch = await bonded.currentEpoch();

      await expect(bonded.connect(a).register()).to.emit(bonded, "Registered");
      await bonded.connect(b).register();

      const wA = await bonded.registeredWeight(epoch, a.address);
      const wB = await bonded.registeredWeight(epoch, b.address);
      const total = await bonded.epochTotalWeight(epoch);
      expect(total).to.equal(wA + wB);
      // a locked 2x b -> roughly 2:1 (ve decays equally so ratio holds).
      expect(wA).to.be.closeTo(wB * 2n, wB / 100n);

      // Advance one epoch so the epoch has ended.
      await time.increase(EPOCH_LEN);

      const emission = await bonded.epochEmission(epoch);
      const expectA = (emission * wA) / total;
      const expectB = (emission * wB) / total;

      await expect(bonded.connect(a).claimMint(epoch))
        .to.emit(bonded, "Claimed")
        .withArgs(epoch, a.address, expectA);
      await bonded.connect(b).claimMint(epoch);

      expect(await bonded.balanceOf(a.address)).to.equal(expectA);
      expect(await bonded.balanceOf(b.address)).to.equal(expectB);
      // total minted ~ emission (minus rounding dust).
      expect((await bonded.totalSupply())).to.be.closeTo(emission, 2n);
    });
  });

  describe("register / claim with StakeLock source", function () {
    it("reads weight from StakeLock.creditsOf and mints pro-rata", async () => {
      const { bonded, a, b } = await loadFixture(stakeLockFixture);
      const epoch = await bonded.currentEpoch();

      await bonded.connect(a).register();
      await bonded.connect(b).register();
      const wA = await bonded.registeredWeight(epoch, a.address);
      const wB = await bonded.registeredWeight(epoch, b.address);
      expect(wA).to.be.gt(0n);
      expect(wB).to.be.gt(0n);

      await time.increase(EPOCH_LEN);
      await bonded.connect(a).claimMint(epoch);
      await bonded.connect(b).claimMint(epoch);

      const total = wA + wB;
      const emission = await bonded.epochEmission(epoch);
      expect(await bonded.balanceOf(a.address)).to.equal((emission * wA) / total);
      expect(await bonded.balanceOf(b.address)).to.equal((emission * wB) / total);
    });
  });

  it("an unregistered account claims nothing (reverts NotRegistered)", async () => {
    const { bonded, a, other } = await loadFixture(veFixture);
    const epoch = await bonded.currentEpoch();
    await bonded.connect(a).register();
    await time.increase(EPOCH_LEN);
    await expect(bonded.connect(other).claimMint(epoch)).to.be.revertedWithCustomError(
      bonded,
      "NotRegistered"
    );
    expect(await bonded.claimableMint(epoch, other.address)).to.equal(0n);
  });

  it("register reverts with no weight", async () => {
    const { bonded, other } = await loadFixture(veFixture);
    await expect(bonded.connect(other).register()).to.be.revertedWithCustomError(bonded, "NoWeight");
  });

  it("double-register in the same epoch reverts", async () => {
    const { bonded, a } = await loadFixture(veFixture);
    await bonded.connect(a).register();
    await expect(bonded.connect(a).register()).to.be.revertedWithCustomError(bonded, "AlreadyRegistered");
  });

  it("claiming before the epoch ends reverts", async () => {
    const { bonded, a } = await loadFixture(veFixture);
    const epoch = await bonded.currentEpoch();
    await bonded.connect(a).register();
    await expect(bonded.connect(a).claimMint(epoch)).to.be.revertedWithCustomError(bonded, "EpochNotEnded");
  });

  it("double-claim reverts", async () => {
    const { bonded, a } = await loadFixture(veFixture);
    const epoch = await bonded.currentEpoch();
    await bonded.connect(a).register();
    await time.increase(EPOCH_LEN);
    await bonded.connect(a).claimMint(epoch);
    await expect(bonded.connect(a).claimMint(epoch)).to.be.revertedWithCustomError(bonded, "AlreadyClaimed");
  });

  it("emission decays by decayBps each epoch", async () => {
    const { bonded } = await loadFixture(veFixture);
    const start = await bonded.startEpoch();
    const e0 = await bonded.epochEmission(start);
    const e1 = await bonded.epochEmission(start + 1n);
    const e2 = await bonded.epochEmission(start + 2n);
    expect(e0).to.equal(BASE_EMISSION);
    expect(e1).to.equal((BASE_EMISSION * (10000n - DECAY_BPS)) / 10000n);
    expect(e2).to.equal((e1 * (10000n - DECAY_BPS)) / 10000n);
    // before the start epoch -> 0
    expect(await bonded.epochEmission(start - 1n)).to.equal(0n);
  });

  it("must re-register each epoch (registration does not carry over)", async () => {
    const { bonded, a } = await loadFixture(veFixture);
    const epoch0 = await bonded.currentEpoch();
    await bonded.connect(a).register();

    await time.increase(EPOCH_LEN);
    const epoch1 = await bonded.currentEpoch();
    expect(epoch1).to.equal(epoch0 + 1n);
    // Not registered for epoch1.
    expect(await bonded.registeredWeight(epoch1, a.address)).to.equal(0n);
  });
});
