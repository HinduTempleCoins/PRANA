const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Seeded deterministic PRNG (mulberry32) for reproducible op sequences.
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

describe("Gauges — invariants", function () {
  const MAX = 1000;

  // ---------------- GaugeController: relative-weight share ----------------
  describe("GaugeController", function () {
    async function deployGC() {
      const [admin, ...rest] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const token = await Mock.deploy("Gov", "GOV");
      const VE = await ethers.getContractFactory("VoteEscrow");
      const ve = await VE.deploy(await token.getAddress(), MAX);
      const GC = await ethers.getContractFactory("GaugeController");
      const gc = await GC.deploy(await ve.getAddress());

      const voters = rest.slice(0, 6);
      for (const v of voters) {
        await token.mint(v.address, 1_000_000n);
        await token.connect(v).approve(await ve.getAddress(), ethers.MaxUint256);
      }
      // gauge addresses: use remaining signer addresses as plain gauge targets
      const gauges = rest.slice(6, 10).map((s) => s.address);
      for (const g of gauges) await gc.addGauge(g);

      return { token, ve, gc, admin, voters, gauges };
    }

    it("INVARIANT: sum of relativeWeight across all gauges never exceeds 100% (1e18)", async () => {
      const { ve, gc, voters, gauges } = await loadFixture(deployGC);
      const rand = mulberry32(0xBADA55);
      const ONE = 1_000_000_000_000_000_000n;

      // Give voters varied locks so they have ve weight.
      for (let i = 0; i < voters.length; i++) {
        const amt = BigInt(1000 + Math.floor(rand() * 9000));
        const dur = 200 + Math.floor(rand() * (MAX - 200));
        await ve.connect(voters[i]).lock(amt, dur);
      }

      const lastGauge = new Map();

      for (let step = 0; step < 100; step++) {
        const v = voters[Math.floor(rand() * voters.length)];
        const op = Math.floor(rand() * 3);

        if (op === 0 || op === 1) {
          // vote / re-vote onto a random gauge (only if voter still has ve weight)
          const w = await ve.balanceOf(v.address);
          if (w > 0n) {
            const g = gauges[Math.floor(rand() * gauges.length)];
            await gc.connect(v).vote(g);
            lastGauge.set(v.address, g);
          }
        } else {
          await time.increase(1 + Math.floor(rand() * 120));
        }

        // INVARIANT: shares sum to <= 1e18 (rounding-down can make it slightly less, never more).
        let sumShares = 0n;
        let sumGaugeWeight = 0n;
        for (const g of gauges) {
          sumShares += await gc.relativeWeight(g);
          sumGaugeWeight += await gc.gaugeWeight(g);
        }
        expect(sumShares <= ONE).to.equal(true);

        // INVARIANT: sum of per-gauge weight == totalWeight (no weight lost/duplicated).
        expect(sumGaugeWeight).to.equal(await gc.totalWeight());

        // If there is any weight at all, the shares should be close to full (within rounding of #gauges).
        if ((await gc.totalWeight()) > 0n) {
          expect(sumShares >= ONE - BigInt(gauges.length)).to.equal(true);
        }
      }
    });

    it("INVARIANT: a user's full current ve weight moves wholesale on re-vote (no weight left behind / double-counted)", async () => {
      const { ve, gc, voters, gauges } = await loadFixture(deployGC);
      const v = voters[0];
      await ve.connect(v).lock(5000n, MAX);

      const wAtVote = await ve.balanceOf(v.address);
      await gc.connect(v).vote(gauges[0]);
      // userWeight snapshot equals the ve weight read at vote time (1 block later it's slightly less,
      // so just assert it equals what the contract stored and that it sits entirely on gauges[0]).
      const stored = await gc.userWeight(v.address);
      expect(await gc.gaugeWeight(gauges[0])).to.equal(stored);
      expect(await gc.totalWeight()).to.equal(stored);
      expect(stored <= wAtVote + 100n).to.equal(true); // sanity: same ballpark as ve weight

      // Re-vote to gauges[1]: old gauge drops to 0, new gets the refreshed snapshot, total == new snapshot only.
      await gc.connect(v).vote(gauges[1]);
      const stored2 = await gc.userWeight(v.address);
      expect(await gc.gaugeWeight(gauges[0])).to.equal(0n);
      expect(await gc.gaugeWeight(gauges[1])).to.equal(stored2);
      expect(await gc.totalWeight()).to.equal(stored2);
    });
  });

  // ---------------- LiquidityGauge: reward accounting ----------------
  describe("LiquidityGauge", function () {
    async function deployLG() {
      const [admin, ...rest] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const stakeT = await Mock.deploy("LP", "LP");
      const rewardT = await Mock.deploy("Rew", "REW");
      const G = await ethers.getContractFactory("LiquidityGauge");
      const gauge = await G.deploy(
        await stakeT.getAddress(),
        await rewardT.getAddress(),
        admin.address
      );

      const stakers = rest.slice(0, 5);
      for (const s of stakers) {
        await stakeT.mint(s.address, 1_000_000n);
        await stakeT.connect(s).approve(await gauge.getAddress(), ethers.MaxUint256);
      }
      // admin is the distributor; fund it generously and approve.
      await rewardT.mint(admin.address, 10_000_000n);
      await rewardT.connect(admin).approve(await gauge.getAddress(), ethers.MaxUint256);

      return { stakeT, rewardT, gauge, admin, stakers };
    }

    it("INVARIANT: total claimed <= total funded; reward balance never under-runs (randomized deposit/withdraw/claim)", async () => {
      const { rewardT, gauge, admin, stakers } = await loadFixture(deployLG);
      const rand = mulberry32(0x5EED12);
      const gAddr = await gauge.getAddress();

      let totalFunded = 0n; // reward tokens transferred into the gauge via notify

      // Track each staker's reward-token balance to measure claims.
      const rewBalBefore = new Map();
      for (const s of stakers) rewBalBefore.set(s.address, await rewardT.balanceOf(s.address));

      // Seed an initial reward stream so rate>0.
      await gauge.connect(admin).notifyRewardAmount(100_000n, 5000);
      totalFunded += 100_000n;

      for (let step = 0; step < 120; step++) {
        const s = stakers[Math.floor(rand() * stakers.length)];
        const op = Math.floor(rand() * 5);

        if (op === 0) {
          // stake
          const amt = BigInt(1 + Math.floor(rand() * 5000));
          await gauge.connect(s).stake(amt);
        } else if (op === 1) {
          // withdraw part/all of stake
          const bal = await gauge.balanceOf(s.address);
          if (bal > 0n) {
            const amt = 1n + (BigInt(Math.floor(rand() * 1_000_000)) % bal);
            await gauge.connect(s).withdraw(amt);
          }
        } else if (op === 2) {
          // claim (payout is measured from balances below)
          await gauge.connect(s).getReward();
        } else if (op === 3) {
          // top up the reward stream occasionally
          if (rand() < 0.5) {
            const amt = BigInt(1000 + Math.floor(rand() * 50_000));
            await gauge.connect(admin).notifyRewardAmount(amt, 1000 + Math.floor(rand() * 4000));
            totalFunded += amt;
          }
        } else {
          // advance time
          await time.increase(1 + Math.floor(rand() * 300));
        }

        // Recompute total claimed from balances (robust to which staker claimed).
        let claimed = 0n;
        for (const st of stakers) {
          claimed += (await rewardT.balanceOf(st.address)) - rewBalBefore.get(st.address);
        }

        // INVARIANT 1: payouts can never exceed what was funded into the gauge.
        expect(claimed <= totalFunded).to.equal(true);

        // INVARIANT 2: gauge still solvent for everything claimed.
        //   funded - claimed == reward tokens still held by gauge (no reward minted from nothing).
        expect(await rewardT.balanceOf(gAddr)).to.equal(totalFunded - claimed);
      }

      // Final settlement: push time past periodFinish, everyone claims, recheck solvency.
      await time.increase(20_000);
      for (const s of stakers) {
        await gauge.connect(s).getReward();
      }
      let claimedFinal = 0n;
      for (const st of stakers) {
        claimedFinal += (await rewardT.balanceOf(st.address)) - rewBalBefore.get(st.address);
      }
      // Total claimed never exceeds total funded (emitted).
      expect(claimedFinal <= totalFunded).to.equal(true);
      // Gauge balance accounts for the unclaimed/dust remainder; never negative.
      expect(await rewardT.balanceOf(gAddr)).to.equal(totalFunded - claimedFinal);
    });

    it("INVARIANT: reward-debt cannot be double-claimed (second consecutive claim pays ~0)", async () => {
      const { rewardT, gauge, admin, stakers } = await loadFixture(deployLG);
      const s = stakers[0];

      await gauge.connect(s).stake(1000n);
      await gauge.connect(admin).notifyRewardAmount(50_000n, 1000);
      await time.increase(600);

      // First claim pays out the accrued amount.
      const before = await rewardT.balanceOf(s.address);
      await gauge.connect(s).getReward();
      const afterFirst = await rewardT.balanceOf(s.address);
      const firstPay = afterFirst - before;
      expect(firstPay > 0n).to.equal(true);

      // Immediate second claim: the claim tx itself mines one block (~1s), so at
      // most ONE second of NEW emission (rewardRate = 50000/1000 = 50/s) can accrue.
      // Anything beyond that would be a double-claim of already-settled debt.
      await gauge.connect(s).getReward();
      const afterSecond = await rewardT.balanceOf(s.address);
      expect(afterSecond - afterFirst).to.be.lte(50n);

      // earned() resets to ~0 right after a claim (only re-accrues with new elapsed time).
      const earnedAfter = await gauge.earned(s.address);
      // allow tiny accrual from the 1 block the second getReward mined
      expect(earnedAfter <= firstPay / 100n + 100n).to.equal(true);
    });

    it("INVARIANT: with one staker for the whole stream, claimable approaches funded (no value created)", async () => {
      const { rewardT, gauge, admin, stakers } = await loadFixture(deployLG);
      const s = stakers[0];
      const gAddr = await gauge.getAddress();

      await gauge.connect(s).stake(1000n);
      const fund = 60_000n;
      const duration = 1000;
      await gauge.connect(admin).notifyRewardAmount(fund, duration);

      // Run well past period finish.
      await time.increase(duration + 500);
      await gauge.connect(s).getReward();

      const paid = await rewardT.balanceOf(s.address);
      // rewardRate = fund/duration truncates; sole staker earns rate*duration <= fund.
      expect(paid <= fund).to.equal(true);
      // Loss is bounded by integer truncation of the rate (< duration wei).
      expect(paid >= fund - BigInt(duration)).to.equal(true);
      // Solvency: gauge holds exactly the un-emitted truncation dust.
      expect(await rewardT.balanceOf(gAddr)).to.equal(fund - paid);
    });
  });
});
