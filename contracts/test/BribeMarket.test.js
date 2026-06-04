const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const MAX = 1_000_000;
const EPOCH_LEN = 7 * 24 * 3600; // 1 week
const EXPIRY = 14 * 24 * 3600;   // 2 weeks past epoch start

describe("BribeMarket", function () {
  async function deploy() {
    const [admin, alice, bob, briber] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const govT = await Mock.deploy("Gov", "GOV");
    const bribeT = await Mock.deploy("Bribe", "BRB");

    const VE = await ethers.getContractFactory("VoteEscrow");
    const ve = await VE.deploy(await govT.getAddress(), MAX);
    const GC = await ethers.getContractFactory("GaugeController");
    const gc = await GC.deploy(await ve.getAddress());

    const BM = await ethers.getContractFactory("BribeMarket");
    const bm = await BM.deploy(await gc.getAddress(), EPOCH_LEN, EXPIRY);

    // Two gauge targets (use signer addresses).
    const gauge1 = admin.address;
    const gauge2 = briber.address;
    await gc.addGauge(gauge1);
    await gc.addGauge(gauge2);

    // Voters get gov, lock, and have ve weight.
    for (const u of [alice, bob]) {
      await govT.mint(u.address, 1_000_000n);
      await govT.connect(u).approve(await ve.getAddress(), ethers.MaxUint256);
    }
    await ve.connect(alice).lock(600_000n, MAX);
    await ve.connect(bob).lock(400_000n, MAX);

    // Briber holds bribe tokens.
    await bribeT.mint(briber.address, 10_000_000n);
    await bribeT.connect(briber).approve(await bm.getAddress(), ethers.MaxUint256);

    return { admin, alice, bob, briber, govT, bribeT, ve, gc, bm, gauge1, gauge2 };
  }

  it("deposit → vote → checkpoint → claim pro-rata to recorded vote weight", async () => {
    const { alice, bob, briber, bribeT, gc, bm, gauge1 } = await loadFixture(deploy);

    // Both vote for gauge1 in the current epoch (epoch 0).
    await gc.connect(alice).vote(gauge1);
    await gc.connect(bob).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    await bm.connect(bob).checkpoint(gauge1);

    const wA = await gc.userWeight(alice.address);
    const wB = await gc.userWeight(bob.address);

    // Briber posts a 1,000,000 bribe for gauge1, epoch 0.
    const amount = 1_000_000n;
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), amount);

    // Claimable is pro-rata to recorded weight.
    const expA = (amount * wA) / (wA + wB);
    const expB = (amount * wB) / (wA + wB);
    expect(await bm.claimable(0, alice.address)).to.equal(expA);
    expect(await bm.claimable(0, bob.address)).to.equal(expB);

    const balABefore = await bribeT.balanceOf(alice.address);
    await bm.connect(alice).claim(0);
    expect((await bribeT.balanceOf(alice.address)) - balABefore).to.equal(expA);

    const balBBefore = await bribeT.balanceOf(bob.address);
    await bm.connect(bob).claim(0);
    expect((await bribeT.balanceOf(bob.address)) - balBBefore).to.equal(expB);
  });

  it("double-claim reverts", async () => {
    const { alice, briber, bribeT, gc, bm, gauge1 } = await loadFixture(deploy);
    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), 1000n);

    await bm.connect(alice).claim(0);
    await expect(bm.connect(alice).claim(0)).to.be.revertedWithCustomError(bm, "AlreadyClaimed");
  });

  it("claiming a bribe for a gauge you didn't vote/checkpoint reverts", async () => {
    const { alice, bob, briber, bribeT, gc, bm, gauge1, gauge2 } = await loadFixture(deploy);
    // Alice checkpoints gauge1; Bob never checkpoints.
    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), 1000n);

    await expect(bm.connect(bob).claim(0)).to.be.revertedWithCustomError(bm, "NothingToClaim");
  });

  it("wrong-epoch claim reverts (checkpoint in a later epoch ≠ bribe's epoch)", async () => {
    const { alice, briber, bribeT, gc, bm, gauge1 } = await loadFixture(deploy);

    // Bribe targets epoch 0.
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), 1000n);

    // Advance to epoch 1, vote + checkpoint there.
    await time.increase(EPOCH_LEN + 1);
    await bm.advanceEpoch();
    expect(await bm.currentEpoch()).to.equal(1n);
    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);

    // Alice has weight in epoch 1, but the bribe is epoch 0 where she has no snapshot.
    expect(await bm.claimable(0, alice.address)).to.equal(0n);
    await expect(bm.connect(alice).claim(0)).to.be.revertedWithCustomError(bm, "NothingToClaim");
  });

  it("checkpoint requires currently voting for the gauge, and is once-per-epoch", async () => {
    const { alice, gc, bm, gauge1, gauge2 } = await loadFixture(deploy);
    // Not voting yet → revert.
    await expect(bm.connect(alice).checkpoint(gauge1)).to.be.revertedWithCustomError(
      bm,
      "NotVotingForGauge"
    );

    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    // Second checkpoint same epoch/gauge → revert.
    await expect(bm.connect(alice).checkpoint(gauge1)).to.be.revertedWithCustomError(
      bm,
      "AlreadyCheckpointed"
    );

    // Checkpointing a gauge she's not voting for → revert.
    await expect(bm.connect(alice).checkpoint(gauge2)).to.be.revertedWithCustomError(
      bm,
      "NotVotingForGauge"
    );
  });

  it("briber sweeps unclaimed remainder after expiry; not before", async () => {
    const { alice, bob, briber, bribeT, gc, bm, gauge1 } = await loadFixture(deploy);
    await gc.connect(alice).vote(gauge1);
    await gc.connect(bob).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    await bm.connect(bob).checkpoint(gauge1);

    const amount = 1_000_000n;
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), amount);

    // Only Alice claims; Bob's share remains unclaimed.
    await bm.connect(alice).claim(0);

    // Sweep before expiry reverts (still in epoch 0).
    await expect(bm.connect(briber).sweep(0)).to.be.revertedWithCustomError(bm, "NotExpired");

    // Advance past the target epoch AND past the expiry window.
    await time.increase(EPOCH_LEN + 1);
    await bm.advanceEpoch(); // now epoch 1
    await time.increase(EXPIRY + 1);

    expect(await bm.isSweepable(0)).to.equal(true);

    const wA = await bm.voterWeight(0, gauge1, alice.address);
    const wB = await bm.voterWeight(0, gauge1, bob.address);
    const claimedByAlice = (amount * wA) / (wA + wB);
    const remainder = amount - claimedByAlice;

    const balBefore = await bribeT.balanceOf(briber.address);
    await bm.connect(briber).sweep(0);
    expect((await bribeT.balanceOf(briber.address)) - balBefore).to.equal(remainder);

    // Second sweep reverts.
    await expect(bm.connect(briber).sweep(0)).to.be.revertedWithCustomError(bm, "AlreadySwept");
  });

  it("only the briber can sweep", async () => {
    const { alice, briber, bribeT, gc, bm, gauge1 } = await loadFixture(deploy);
    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);
    await bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), 1000n);

    await time.increase(EPOCH_LEN + 1);
    await bm.advanceEpoch();
    await time.increase(EXPIRY + 1);

    await expect(bm.connect(alice).sweep(0)).to.be.revertedWithCustomError(bm, "NotBriber");
  });

  it("cannot bribe a past epoch", async () => {
    const { briber, bribeT, bm, gauge1 } = await loadFixture(deploy);
    await time.increase(EPOCH_LEN + 1);
    await bm.advanceEpoch(); // epoch 1
    await expect(
      bm.connect(briber).depositBribe(gauge1, 0, await bribeT.getAddress(), 1000n)
    ).to.be.revertedWithCustomError(bm, "BadEpoch");
  });

  it("fee-on-transfer bribe token credits actual received amount", async () => {
    const { alice, briber, gc, bm, gauge1 } = await loadFixture(deploy);
    const FoT = await ethers.getContractFactory("FeeOnTransferToken");
    const fee = await FoT.deploy("FeeBrb", "FBRB", 100); // 1%
    await fee.mint(briber.address, 1_000_000n);
    await fee.connect(briber).approve(await bm.getAddress(), ethers.MaxUint256);

    await gc.connect(alice).vote(gauge1);
    await bm.connect(alice).checkpoint(gauge1);

    await bm.connect(briber).depositBribe(gauge1, 0, await fee.getAddress(), 1000n);
    // Received 990 after 1% fee → bribe.amount stored as 990, sole voter claims all of it.
    const b = await bm.bribes(0);
    expect(b.amount).to.equal(990n);
    expect(await bm.claimable(0, alice.address)).to.equal(990n);
  });
});
