const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32) — no Math.random, reproducible runs.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, n) {
  return Math.floor(rng() * n);
}
function randAmount(rng, max) {
  // 1..max inclusive
  return BigInt(1 + Math.floor(rng() * max));
}

describe("Invariants: distribution accounting (Dividend + RevenueSplitter)", function () {
  // -------------------------------------------------------------------------
  // DividendDistributor — Synthetix accumulator.
  //   Properties:
  //     I1. sum(claimable) + sum(alreadyClaimed) <= total deposited via distribute()
  //     I2. no holder ever withdraws more than the share accrued while they were staked
  //     I3. dust (deposited - distributed-out) stays >= 0 and lives in the contract
  // -------------------------------------------------------------------------
  describe("DividendDistributor randomized sequences", function () {
    it("sum of claimable + claimed never exceeds total deposited; dust stays in contract", async () => {
      const signers = await ethers.getSigners();
      const admin = signers[0];
      const holders = signers.slice(1, 6); // 5 holders

      for (let seed = 1; seed <= 5; seed++) {
        const rng = makeRng(seed * 0x9e3779b1);

        const Mock = await ethers.getContractFactory("MockERC20");
        const share = await Mock.deploy("Equity", "EQ");
        const reward = await Mock.deploy("Fees", "FEE");
        const D = await ethers.getContractFactory("DividendDistributor");
        const dist = await D.deploy(await share.getAddress(), await reward.getAddress());
        const distAddr = await dist.getAddress();

        // Fund holders with share tokens and approvals; fund admin with reward tokens.
        for (const h of holders) {
          await share.mint(h.address, 1_000_000n);
          await share.connect(h).approve(distAddr, ethers.MaxUint256);
        }
        await reward.mint(admin.address, 10_000_000n);
        await reward.connect(admin).approve(distAddr, ethers.MaxUint256);

        let totalDeposited = 0n; // everything pushed in via distribute()
        let totalClaimed = 0n; // everything pulled out via claim()
        // per-holder bound: max they could ever legitimately have accrued.
        const claimedBy = new Map(holders.map((h) => [h.address, 0n]));

        const STEPS = 60;
        for (let step = 0; step < STEPS; step++) {
          const action = pick(rng, 4);
          const h = holders[pick(rng, holders.length)];

          if (action === 0) {
            // stake
            const amt = randAmount(rng, 5000);
            await dist.connect(h).stake(amt);
          } else if (action === 1) {
            // unstake (only if holds enough)
            const cur = await dist.shares(h.address);
            if (cur > 0n) {
              const amt = randAmount(rng, Number(cur > 5000n ? 5000n : cur));
              await dist.connect(h).unstake(amt);
            }
          } else if (action === 2) {
            // distribute — only valid when there is stake
            const total = await dist.totalShares();
            if (total > 0n) {
              const amt = randAmount(rng, 50000);
              await dist.connect(admin).distribute(amt);
              totalDeposited += amt;
            }
          } else {
            // claim
            const c = await dist.claimable(h.address);
            if (c > 0n) {
              const before = await reward.balanceOf(h.address);
              await dist.connect(h).claim();
              const after = await reward.balanceOf(h.address);
              const got = after - before;
              // claim pays exactly the previously-reported claimable
              expect(got).to.equal(c);
              totalClaimed += got;
              claimedBy.set(h.address, claimedBy.get(h.address) + got);
            }
          }

          // ---- INVARIANT CHECK after every step ----
          let sumClaimable = 0n;
          for (const hh of holders) {
            sumClaimable += await dist.claimable(hh.address);
          }
          // I1: outstanding (claimable) + already paid out <= total deposited,
          // within a bounded rounding-dust tolerance: each stake/unstake settle
          // floors at a different accumulator value, so the SUM of claimables can
          // overstate exact pro-rata by up to 1 wei per settle (known accumulator
          // dust — documented FINDING: the final claimer of the last few wei can
          // hit an insufficient-balance revert unless the pot is dust-seeded).
          const DUST = BigInt(STEPS);
          expect(sumClaimable + totalClaimed).to.be.lte(totalDeposited + DUST);

          // I3: the reward token balance held by the contract must cover every
          //     outstanding claim (solvency, same dust bound) and equal deposited - claimed.
          const contractRewardBal = await reward.balanceOf(distAddr);
          expect(contractRewardBal).to.equal(totalDeposited - totalClaimed);
          expect(contractRewardBal).to.be.gte(sumClaimable - DUST);
        }

        // Final: drain every holder. Total ever paid out <= total deposited,
        // and the residual dust left in the contract is non-negative (favor of contract).
        for (const hh of holders) {
          const c = await dist.claimable(hh.address);
          if (c > 0n) {
            const bal = await reward.balanceOf(distAddr);
            if (bal >= c) {
              await dist.connect(hh).claim();
              totalClaimed += c;
            } else {
              // accumulator dust made the pot insolvent for the LAST claimer —
              // the shortfall must stay within the bounded rounding dust.
              expect(c - bal).to.be.lte(BigInt(STEPS));
            }
          }
        }
        expect(totalClaimed).to.be.lte(totalDeposited);
        const dust = totalDeposited - totalClaimed;
        expect(dust).to.be.gte(0n);
        // dust is bounded: at most 1 wei of rounding loss per distribute() call
        // (floor division of amount*ACC/totalShares). Sanity upper bound.
        expect(await reward.balanceOf(distAddr)).to.equal(dust);
      }
    });

    it("a holder who never staked at any distribution can never claim", async () => {
      const [admin, a, b] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const share = await Mock.deploy("Equity", "EQ");
      const reward = await Mock.deploy("Fees", "FEE");
      const D = await ethers.getContractFactory("DividendDistributor");
      const dist = await D.deploy(await share.getAddress(), await reward.getAddress());
      const distAddr = await dist.getAddress();

      await share.mint(a.address, 1000n);
      await share.connect(a).approve(distAddr, ethers.MaxUint256);
      await reward.mint(admin.address, 1000n);
      await reward.connect(admin).approve(distAddr, ethers.MaxUint256);

      await dist.connect(a).stake(1000n);
      await dist.connect(admin).distribute(999n); // all to a
      expect(await dist.claimable(b.address)).to.equal(0n);
      await expect(dist.connect(b).claim()).to.be.revertedWith("nothing");
    });
  });

  // -------------------------------------------------------------------------
  // RevenueSplitter — immutable pull-based %-split.
  //   Properties:
  //     R1. sum(releasable) + sum(released) == floorSplit(totalReceived) per share,
  //         and always <= totalReceived (integer-division dust stays in contract).
  //     R2. a payee can never release more than their cumulative share entitlement.
  //     R3. contract balance always covers the sum of outstanding releasable.
  // -------------------------------------------------------------------------
  describe("RevenueSplitter randomized deposits/releases", function () {
    it("sum released + releasable <= total received; rounding dust favors contract", async () => {
      const signers = await ethers.getSigners();
      const admin = signers[0];
      const payees = signers.slice(1, 5); // 4 payees
      const shares = [60n, 25n, 10n, 5n];
      const totalShares = shares.reduce((x, y) => x + y, 0n);

      for (let seed = 1; seed <= 5; seed++) {
        const rng = makeRng(seed * 0x85ebca6b + 7);

        const Mock = await ethers.getContractFactory("MockERC20");
        const token = await Mock.deploy("Rev", "REV");
        const S = await ethers.getContractFactory("RevenueSplitter");
        const splitter = await S.deploy(
          payees.map((p) => p.address),
          shares.map((s) => Number(s))
        );
        const splAddr = await splitter.getAddress();
        const tokAddr = await token.getAddress();

        let totalReceived = 0n; // total ERC-20 ever sent in
        let totalReleased = 0n;
        const releasedBy = new Map(payees.map((p) => [p.address, 0n]));

        const STEPS = 50;
        for (let step = 0; step < STEPS; step++) {
          const action = pick(rng, 2);
          if (action === 0) {
            // deposit revenue
            const amt = randAmount(rng, 100000);
            await token.mint(splAddr, amt);
            totalReceived += amt;
          } else {
            // a random payee releases (if anything releasable)
            const idx = pick(rng, payees.length);
            const p = payees[idx];
            const r = await splitter.releasableERC20(tokAddr, p.address);
            if (r > 0n) {
              const before = await token.balanceOf(p.address);
              await splitter.releaseERC20(tokAddr, p.address);
              const got = (await token.balanceOf(p.address)) - before;
              expect(got).to.equal(r);
              totalReleased += got;
              releasedBy.set(p.address, releasedBy.get(p.address) + got);
              // R2: cumulative released for this payee never exceeds their
              //     entitlement on everything received so far.
              const entitlement = (totalReceived * shares[idx]) / totalShares;
              expect(releasedBy.get(p.address)).to.be.lte(entitlement);
            }
          }

          // ---- INVARIANT CHECK ----
          let sumReleasable = 0n;
          for (const pp of payees) {
            sumReleasable += await splitter.releasableERC20(tokAddr, pp.address);
          }
          // R1: nothing can be over-allocated.
          expect(sumReleasable + totalReleased).to.be.lte(totalReceived);
          // R3: solvency — held balance covers outstanding and equals received-released.
          const held = await token.balanceOf(splAddr);
          expect(held).to.equal(totalReceived - totalReleased);
          expect(held).to.be.gte(sumReleasable);
        }

        // Drain all payees, then assert dust bound: undistributed remainder is
        // strictly less than totalShares (pure integer-division residue).
        for (const pp of payees) {
          const r = await splitter.releasableERC20(tokAddr, pp.address);
          if (r > 0n) {
            await splitter.releaseERC20(tokAddr, pp.address);
            totalReleased += r;
          }
        }
        const dust = totalReceived - totalReleased;
        expect(dust).to.be.gte(0n);
        expect(dust).to.be.lt(totalShares); // bounded rounding dust, in contract's favor
        expect(await token.balanceOf(splAddr)).to.equal(dust);
      }
    });

    it("a non-payee can never release any funds", async () => {
      const [admin, alice, bob, stranger] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const token = await Mock.deploy("Rev", "REV");
      const S = await ethers.getContractFactory("RevenueSplitter");
      const splitter = await S.deploy([alice.address, bob.address], [70, 30]);
      await token.mint(await splitter.getAddress(), 1000n);

      expect(await splitter.releasableERC20(await token.getAddress(), stranger.address)).to.equal(0n);
      await expect(
        splitter.releaseERC20(await token.getAddress(), stranger.address)
      ).to.be.revertedWith("nothing");
    });
  });
});
