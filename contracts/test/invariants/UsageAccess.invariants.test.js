const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("UsageBurn + AccessGate — invariants", function () {
  const INITIAL = 1_000_000n;
  const PRICE = 7n; // tokens per second; non-trivial so floor rounding bites

  async function usageFixture() {
    const [admin, ...rest] = await ethers.getSigners();
    const users = rest.slice(0, 5);
    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Usage", "USE");
    const UB = await ethers.getContractFactory("UsageBurn");
    const gate = await UB.deploy(await token.getAddress());
    for (const u of users) {
      await token.mint(u.address, INITIAL);
      await token.connect(u).approve(await gate.getAddress(), ethers.MaxUint256);
    }
    return { token, gate, users };
  }

  async function accessFixture() {
    const [admin, ...rest] = await ethers.getSigners();
    const users = rest.slice(0, 5);
    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Access", "ACC");
    const AG = await ethers.getContractFactory("AccessGate");
    const gate = await AG.deploy(await token.getAddress(), PRICE);
    for (const u of users) {
      await token.mint(u.address, INITIAL);
      await token.connect(u).approve(await gate.getAddress(), ethers.MaxUint256);
    }
    return { token, gate, users };
  }

  it("UsageBurn conserves the supply identity: totalSupply == initial - totalBurned, and sum(burnedBy) == totalBurned", async () => {
    const { token, gate, users } = await loadFixture(usageFixture);
    const rng = makeRng(0xdead);
    const startSupply = await token.totalSupply(); // = INITIAL * users.length

    for (let i = 0; i < 150; i++) {
      const u = users[Math.floor(rng() * users.length)];
      const bal = await token.balanceOf(u.address);
      if (bal === 0n) continue;
      const amount = BigInt(1 + Math.floor(rng() * Number(bal > 5000n ? 5000n : bal)));
      const ref = ethers.id("ref-" + i);

      await gate.connect(u).use(amount, ref);

      // Identity 1: every burned token left circulating supply.
      expect(await token.totalSupply()).to.equal(startSupply - (await gate.totalBurned()));

      // Identity 2: per-user tallies sum to the global tally.
      let sum = 0n;
      for (const x of users) sum += await gate.burnedBy(x.address);
      expect(sum).to.equal(await gate.totalBurned());
    }
  });

  it("AccessGate burns exactly secondsBought * price (whole-second cost, no over/under-charge)", async () => {
    const { token, gate, users } = await loadFixture(accessFixture);
    const rng = makeRng(0xbeef);

    let totalBurnedExpected = 0n;
    const startSupply = await token.totalSupply();

    for (let i = 0; i < 120; i++) {
      const u = users[Math.floor(rng() * users.length)];
      const amount = BigInt(Math.floor(rng() * 3000));
      const secs = amount / PRICE;

      if (secs === 0n) {
        await expect(gate.connect(u).buy(amount)).to.be.revertedWith("too little");
        continue;
      }

      const cost = secs * PRICE;
      const balBefore = await token.balanceOf(u.address);
      await gate.connect(u).buy(amount);
      const balAfter = await token.balanceOf(u.address);

      // Exactly the whole-second cost is burned — never the full `amount`, never more.
      expect(balBefore - balAfter).to.equal(cost);
      expect(cost).to.be.lte(amount);
      totalBurnedExpected += cost;

      // Supply conservation against the cumulative burn.
      expect(await token.totalSupply()).to.equal(startSupply - totalBurnedExpected);
    }
  });

  it("AccessGate sets the access flag ONLY for the exact required burn (off-by-one underpayment reverts)", async () => {
    const { gate, users } = await loadFixture(accessFixture);
    const u = users[0];

    // One token short of a whole second -> 0 seconds -> revert, flag never set.
    await expect(gate.connect(u).buy(PRICE - 1n)).to.be.revertedWith("too little");
    expect(await gate.hasAccess(u.address)).to.equal(false);
    expect(await gate.accessUntil(u.address)).to.equal(0n);

    // Exactly the price of one second -> access granted for exactly one second.
    const tx = await gate.connect(u).buy(PRICE);
    const expiry = await gate.accessUntil(u.address);
    const blk = await ethers.provider.getBlock(tx.blockNumber);
    expect(expiry).to.equal(BigInt(blk.timestamp) + 1n);
    expect(await gate.hasAccess(u.address)).to.equal(true);
  });

  it("AccessGate: access stacking conserves time additively across randomized buys", async () => {
    const { gate, users } = await loadFixture(accessFixture);
    const rng = makeRng(0x5eed);
    const u = users[1];

    let purchasedSeconds = 0n;

    for (let i = 0; i < 40; i++) {
      const amount = BigInt(Number(PRICE) + Math.floor(rng() * 500));
      const secs = amount / PRICE;
      if (secs === 0n) continue;

      const before = await gate.accessUntil(u.address);
      const blkBefore = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const base = before > blkBefore ? before : blkBefore;

      await gate.connect(u).buy(amount);
      const after = await gate.accessUntil(u.address);

      // New expiry extends from max(now, currentExpiry) by exactly secsBought.
      // (Tolerate the +1s the mined tx adds to `now` when access had lapsed.)
      expect(after).to.be.gte(base + secs);
      expect(after).to.be.lte(base + secs + 1n);
      purchasedSeconds += secs;
    }

    expect(await gate.accessUntil(u.address)).to.be.gt(0n);
  });
});
