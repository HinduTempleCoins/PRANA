const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Seeded deterministic PRNG (mulberry32) so operation sequences are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("VoteEscrow — invariants", function () {
  const MAX = 1000;

  async function deployFixture() {
    const signers = await ethers.getSigners();
    const [admin, ...users] = signers;
    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Gov", "GOV");
    const VE = await ethers.getContractFactory("VoteEscrow");
    const ve = await VE.deploy(await token.getAddress(), MAX);

    // Fund a handful of users and pre-approve.
    const actors = users.slice(0, 6);
    for (const u of actors) {
      await token.mint(u.address, 1_000_000n);
      await token.connect(u).approve(await ve.getAddress(), ethers.MaxUint256);
    }
    return { token, ve, admin, actors };
  }

  // weight(user) = amount * (end - now) / maxLock, clamped to 0 once end <= now.
  function expectedWeight(amount, end, now) {
    if (end <= now) return 0n;
    return (amount * (BigInt(end) - BigInt(now))) / BigInt(MAX);
  }

  it("voting weight decays monotonically toward exactly 0 at unlock (sampled)", async () => {
    const { ve, actors } = await loadFixture(deployFixture);
    const u = actors[0];

    await ve.connect(u).lock(1000n, MAX);
    const l = await ve.locks(u.address);
    const end = Number(l.end);

    let prev = await ve.balanceOf(u.address);
    // Sample across the whole lock window plus past expiry.
    const samples = [50, 100, 100, 150, 200, 250, 300, 1];
    for (const dt of samples) {
      await time.increase(dt);
      const now = await time.latest();
      const w = await ve.balanceOf(u.address);

      // Matches the closed-form the contract computes.
      expect(w).to.equal(expectedWeight(1000n, end, now));
      // Never increases as time passes.
      expect(w <= prev).to.equal(true);
      prev = w;
    }

    // Strictly past the end: weight must be exactly zero.
    // (the sample loop may already have walked past end — only jump forward)
    if ((await time.latest()) < end + 5) await time.increaseTo(end + 5);
    expect(await ve.balanceOf(u.address)).to.equal(0n);
  });

  it("weight is 0 exactly at end and forever after, for varied durations", async () => {
    const { ve, actors } = await loadFixture(deployFixture);
    const durations = [1, 250, 500, 999, MAX];
    for (let i = 0; i < durations.length; i++) {
      const u = actors[i];
      const d = durations[i];
      await ve.connect(u).lock(777n, d);
      const end = Number((await ve.locks(u.address)).end);
      // Just before end: sample the weight (for d=1 the lock tx itself may
      // already sit at end-1, so only move time forward, never backward).
      if ((await time.latest()) < end - 1) await time.increaseTo(end - 1);
      const sampleAt = await time.latest();
      const before = await ve.balanceOf(u.address);
      // At end: exactly 0.
      if ((await time.latest()) < end) await time.increaseTo(end);
      expect(await ve.balanceOf(u.address)).to.equal(0n);
      // After end: stays 0.
      await time.increaseTo(end + 100);
      expect(await ve.balanceOf(u.address)).to.equal(0n);
      // sanity: the closed form for the pre-end sample held
      expect(before).to.equal(expectedWeight(777n, end, sampleAt));
    }
  });

  it("locked principal is withdrawable exactly once at/after end, never before; double-withdraw reverts", async () => {
    const { token, ve, actors } = await loadFixture(deployFixture);
    const u = actors[0];

    await ve.connect(u).lock(1000n, MAX);
    const balBefore = await token.balanceOf(u.address);

    // Before end: cannot withdraw.
    await expect(ve.connect(u).withdraw()).to.be.revertedWith("still locked");
    await time.increase(MAX - 10);
    await expect(ve.connect(u).withdraw()).to.be.revertedWith("still locked");

    // At/after end: withdraw returns exactly the principal.
    await time.increase(20);
    await ve.connect(u).withdraw();
    expect(await token.balanceOf(u.address)).to.equal(balBefore + 1000n);

    // Withdraw again immediately: reverts ("no lock"), no second payout.
    await expect(ve.connect(u).withdraw()).to.be.revertedWith("no lock");
    // And again later — still nothing extra to claim.
    await time.increase(1000);
    await expect(ve.connect(u).withdraw()).to.be.revertedWith("no lock");
    expect(await token.balanceOf(u.address)).to.equal(balBefore + 1000n);
  });

  it("INVARIANT: sum of all live principals == totalLocked, across randomized lock/increase/withdraw", async () => {
    const { token, ve, actors } = await loadFixture(deployFixture);
    const rand = mulberry32(0xC0FFEE);
    const veAddr = await ve.getAddress();

    // Mirror of on-chain lock state for cross-checking.
    const state = new Map(); // address -> { amount: bigint, end: number }
    for (const u of actors) state.set(u.address, { amount: 0n, end: 0 });

    const tokenBalBefore = new Map();
    for (const u of actors) tokenBalBefore.set(u.address, await token.balanceOf(u.address));

    for (let step = 0; step < 80; step++) {
      const u = actors[Math.floor(rand() * actors.length)];
      const s = state.get(u.address);
      const now = await time.latest();
      const op = Math.floor(rand() * 4);

      if (op === 0) {
        // lock (only if no active lock)
        if (s.amount === 0n) {
          const amt = BigInt(1 + Math.floor(rand() * 5000));
          const dur = 1 + Math.floor(rand() * MAX);
          await ve.connect(u).lock(amt, dur);
          s.amount = amt;
          s.end = now + 1 + dur; // +1: tx mines one block forward
          // resync end from chain to avoid off-by-one drift
          s.end = Number((await ve.locks(u.address)).end);
        }
      } else if (op === 1) {
        // increaseAmount (only with an active, unexpired lock)
        if (s.amount > 0n && s.end > (await time.latest())) {
          const amt = BigInt(1 + Math.floor(rand() * 3000));
          await ve.connect(u).increaseAmount(amt);
          s.amount += amt;
        }
      } else if (op === 2) {
        // withdraw (only at/after end)
        if (s.amount > 0n && (await time.latest()) >= s.end) {
          await ve.connect(u).withdraw();
          s.amount = 0n;
          s.end = 0;
        }
      } else {
        // advance time
        await time.increase(1 + Math.floor(rand() * 250));
      }

      // ---- INVARIANTS checked every step ----
      // 1. sum of mirrored principals == on-chain totalLocked
      let sum = 0n;
      for (const v of state.values()) sum += v.amount;
      expect(await ve.totalLocked()).to.equal(sum);

      // 2. contract's token balance == totalLocked (no principal lost/created)
      expect(await token.balanceOf(veAddr)).to.equal(sum);

      // 3. each user's reported voting weight == closed-form from mirrored state
      const t = await time.latest();
      for (const u2 of actors) {
        const s2 = state.get(u2.address);
        const w = await ve.balanceOf(u2.address);
        expect(w).to.equal(expectedWeight(s2.amount, s2.end, t));
        // weight can never exceed the locked principal
        expect(w <= s2.amount).to.equal(true);
      }
    }

    // Drain: advance well past any lock and withdraw everyone; everyone recovers exactly their net principal.
    await time.increase(2 * MAX);
    for (const u of actors) {
      const s = state.get(u.address);
      if (s.amount > 0n) {
        await ve.connect(u).withdraw();
      }
    }
    expect(await ve.totalLocked()).to.equal(0n);
    expect(await token.balanceOf(veAddr)).to.equal(0n);
    // No user gained or lost tokens overall (principal conserved).
    for (const u of actors) {
      expect(await token.balanceOf(u.address)).to.equal(tokenBalBefore.get(u.address));
    }
  });
});
