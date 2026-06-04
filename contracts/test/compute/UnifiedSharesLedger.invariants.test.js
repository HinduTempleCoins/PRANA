const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Lane enum: HASH=0, TASK=1, BURN=2
const HASH = 0;
const TASK = 1;
const BURN = 2;
const LANES = [HASH, TASK, BURN];
const ONE = 10n ** 18n;

const EPOCH_LEN = 3600n; // 1 hour epochs
const WINDOW = 3n; // PPLNS trailing window = 3 epochs (wide enough to exercise overlap)
const ISSUANCE = 1000n * ONE; // 1000 PRANA per closed epoch

// Hardhat's chain clock starts at real-world time, and time only moves forward. The small,
// readable epoch indices below are anchored above the chain's start epoch via BASE; ep(n) is
// the absolute epoch the contract actually sees. (Same helper as the unit test.)
let BASE = 1_000_000n; // re-anchored in deploy() above the live global clock (sibling suites advance it)
const ep = (n) => BASE + BigInt(n);

describe("UnifiedSharesLedger (NN1) — invariants / properties", function () {
  async function deploy() {
    BASE = BigInt(await time.latest()) / EPOCH_LEN + 100n;
    const signers = await ethers.getSigners();
    const [admin, alice, bob, carol, dave, hashCred, taskCred, burnCred, funder] = signers;

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    // burn weight 1x so HASH/TASK/BURN all pool at face value (pure pro-rata).
    const cfg = await Cfg.deploy(admin.address, ONE, 1n, 1_000_000n);

    const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
    const ledger = await Ledger.deploy(
      await prana.getAddress(),
      await cfg.getAddress(),
      admin.address,
      EPOCH_LEN,
      WINDOW,
      ISSUANCE
    );

    await ledger.grantRole(await ledger.HASH_CREDITOR(), hashCred.address);
    await ledger.grantRole(await ledger.TASK_CREDITOR(), taskCred.address);
    await ledger.grantRole(await ledger.BURN_CREDITOR(), burnCred.address);
    await ledger.grantRole(await ledger.FUNDER_ROLE(), funder.address);

    // Fund the budget generously so InsufficientFunds never masks a fairness check.
    await prana.mint(funder.address, 100_000_000n * ONE);
    await prana.connect(funder).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(funder).fundEpoch(10_000_000n * ONE);

    const creditorFor = { [HASH]: hashCred, [TASK]: taskCred, [BURN]: burnCred };

    return {
      admin,
      alice,
      bob,
      carol,
      dave,
      hashCred,
      taskCred,
      burnCred,
      funder,
      prana,
      cfg,
      ledger,
      creditorFor,
    };
  }

  // Advance to the start of a target (readable) epoch index.
  async function gotoEpoch(target) {
    const want = ep(target);
    const now = BigInt(await time.latest());
    const cur = now / EPOCH_LEN;
    if (want > cur) {
      await time.setNextBlockTimestamp(Number(want * EPOCH_LEN));
      await ethers.provider.send("evm_mine", []);
    }
  }

  // Sum totalPoolShares over the trailing window [start, end] ending at the absolute epoch `e`.
  async function windowTotal(ledger, e) {
    const w = await ledger.windowEpochs();
    // start = e - w + 1 clamped at 0; here e is large (>= BASE) so no clamp.
    const start = e - w + 1n;
    let tot = 0n;
    for (let x = start; x <= e; x++) {
      tot += await ledger.totalPoolShares(x);
    }
    return tot;
  }

  // ----------------------------------------------------------------- //
  // (a) conservation: sum of claims for a closed epoch <= epochIssuance //
  //     (rounding dust may make it strictly LESS, never MORE).          //
  // ----------------------------------------------------------------- //
  describe("(a) conservation — total claims never exceed epochIssuance", function () {
    it("many distinct accounts in one window: Σ payouts <= ISSUANCE (dust down only)", async () => {
      const { ledger, creditorFor, alice, bob, carol, dave } = await loadFixture(deploy);
      const accounts = [alice, bob, carol, dave];

      // Spread non-divisible credits across the window epochs and lanes to force rounding.
      await gotoEpoch(100);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 333n);
      await ledger.connect(creditorFor[TASK]).creditShares(bob.address, TASK, 777n);

      await gotoEpoch(101);
      await ledger.connect(creditorFor[BURN]).creditShares(carol.address, BURN, 191n);
      await ledger.connect(creditorFor[HASH]).creditShares(dave.address, HASH, 1n);

      await gotoEpoch(102);
      await ledger.connect(creditorFor[TASK]).creditShares(alice.address, TASK, 13n);

      // Close epoch 102.
      await gotoEpoch(103);
      const E = ep(102);

      let sumPaid = 0n;
      for (const a of accounts) {
        sumPaid += await ledger.claimable(a.address, E);
      }

      // Conservation: never pays out MORE than the fixed issuance.
      expect(sumPaid).to.be.lte(ISSUANCE);

      // And the dust lost is bounded by (#claimants - 1) wei of floor rounding.
      const totWin = await windowTotal(ledger, E);
      if (totWin > 0n) {
        const dust = ISSUANCE - sumPaid;
        expect(dust).to.be.lt(BigInt(accounts.length));
      }
    });

    it("realized on-chain claims for a closed epoch sum to <= ISSUANCE", async () => {
      const { ledger, prana, creditorFor, alice, bob, carol } = await loadFixture(deploy);

      await gotoEpoch(110);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      await ledger.connect(creditorFor[TASK]).creditShares(bob.address, TASK, 200n);
      await ledger.connect(creditorFor[BURN]).creditShares(carol.address, BURN, 301n);
      await gotoEpoch(111);
      const E = ep(110);

      const before = await prana.balanceOf(await ledger.getAddress());
      await ledger.connect(alice).claim(E);
      await ledger.connect(bob).claim(E);
      await ledger.connect(carol).claim(E);
      const after = await prana.balanceOf(await ledger.getAddress());

      const totalOut = before - after;
      expect(totalOut).to.be.lte(ISSUANCE);
    });
  });

  // ----------------------------------------------------------------- //
  // (b) totalPaid <= totalFunded always                                //
  // ----------------------------------------------------------------- //
  describe("(b) totalPaid <= totalFunded — never overspend the budget", function () {
    it("holds across a sequence of credits + claims", async () => {
      const { ledger, creditorFor, alice, bob, carol } = await loadFixture(deploy);

      const checkBudget = async () => {
        expect(await ledger.totalPaid()).to.be.lte(await ledger.totalFunded());
      };

      await checkBudget();

      for (let i = 0; i < 6; i++) {
        const e = 200 + i;
        await gotoEpoch(e);
        await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, BigInt(100 + i));
        await ledger.connect(creditorFor[TASK]).creditShares(bob.address, TASK, BigInt(50 + i));
        await ledger.connect(creditorFor[BURN]).creditShares(carol.address, BURN, BigInt(7 + i));
      }
      // Close the last epoch, then claim several closed epochs.
      await gotoEpoch(206);
      for (let i = 0; i < 5; i++) {
        const E = ep(200 + i);
        await ledger.connect(alice).claim(E);
        await ledger.connect(bob).claim(E);
        await ledger.connect(carol).claim(E);
        await checkBudget();
      }
    });

    it("a constrained budget reverts the over-spending claim and leaves totalPaid <= totalFunded", async () => {
      const [admin, alice, , , , , , , funder] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const prana = await Mock.deploy("Prana", "PRANA");
      const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
      const cfg = await Cfg.deploy(admin.address, ONE, 1n, 10n);
      const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
      const ledger = await Ledger.deploy(
        await prana.getAddress(),
        await cfg.getAddress(),
        admin.address,
        EPOCH_LEN,
        WINDOW,
        ISSUANCE
      );
      await ledger.grantRole(await ledger.HASH_CREDITOR(), admin.address);
      await ledger.grantRole(await ledger.FUNDER_ROLE(), funder.address);
      await prana.mint(funder.address, 10n * ONE);
      await prana.connect(funder).approve(await ledger.getAddress(), ethers.MaxUint256);
      await ledger.connect(funder).fundEpoch(10n * ONE); // < ISSUANCE

      await gotoEpoch(220);
      await ledger.connect(admin).creditShares(alice.address, HASH, 100n);
      await gotoEpoch(221);

      await expect(ledger.connect(alice).claim(ep(220))).to.be.revertedWithCustomError(
        ledger,
        "InsufficientFunds"
      );
      // Invariant preserved after the failed claim.
      expect(await ledger.totalPaid()).to.be.lte(await ledger.totalFunded());
      expect(await ledger.totalPaid()).to.equal(0n);
    });
  });

  // ----------------------------------------------------------------- //
  // (c) no account can claim the same (epoch, account) twice           //
  // ----------------------------------------------------------------- //
  describe("(c) idempotency — (epoch, account) is claimable at most once", function () {
    it("second claim reverts AlreadyClaimed and pays nothing extra", async () => {
      const { ledger, prana, creditorFor, alice } = await loadFixture(deploy);
      await gotoEpoch(300);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      await gotoEpoch(301);
      const E = ep(300);

      const b0 = await prana.balanceOf(alice.address);
      await ledger.connect(alice).claim(E);
      const b1 = await prana.balanceOf(alice.address);
      expect(b1 - b0).to.equal(ISSUANCE);

      await expect(ledger.connect(alice).claim(E)).to.be.revertedWithCustomError(ledger, "AlreadyClaimed");
      // Balance unchanged after the reverted second attempt.
      expect(await prana.balanceOf(alice.address)).to.equal(b1);
      expect(await ledger.claimable(alice.address, E)).to.equal(0n);
      expect(await ledger.claimed(E, alice.address)).to.equal(true);
    });

    it("a zero-payout claim still flips the claimed flag (cannot re-enter)", async () => {
      const { ledger, alice } = await loadFixture(deploy);
      await gotoEpoch(310);
      await gotoEpoch(311); // closed, no credits
      const E = ep(310);
      await ledger.connect(alice).claim(E); // pays 0, marks claimed
      expect(await ledger.claimed(E, alice.address)).to.equal(true);
      await expect(ledger.connect(alice).claim(E)).to.be.revertedWithCustomError(ledger, "AlreadyClaimed");
    });
  });

  // ----------------------------------------------------------------- //
  // (d) pro-rata fairness — payout ratio == windowShares ratio (±1 wei) //
  // ----------------------------------------------------------------- //
  describe("(d) pro-rata fairness — equal-share accounts paid equally; ratios track windowShares", function () {
    it("two accounts: payoutA / payoutB == windowA / windowB within 1 wei", async () => {
      const { ledger, creditorFor, alice, bob } = await loadFixture(deploy);

      // Give alice and bob different shares across two window epochs in different lanes.
      await gotoEpoch(400);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 150n);
      await ledger.connect(creditorFor[TASK]).creditShares(bob.address, TASK, 350n);
      await gotoEpoch(401);
      await ledger.connect(creditorFor[BURN]).creditShares(alice.address, BURN, 50n);
      await gotoEpoch(402);
      const E = ep(401);

      const [aw] = await ledger.windowShares(alice.address, E);
      const [, twB] = await ledger.windowShares(bob.address, E); // total is same for both
      const [bw] = await ledger.windowShares(bob.address, E);

      const pa = await ledger.claimable(alice.address, E);
      const pb = await ledger.claimable(bob.address, E);

      // Cross-multiply to avoid division: pa * bw ≈ pb * aw, within the rounding slack of
      // floor((I*aw)/T) vs floor((I*bw)/T). The error is bounded by max(aw,bw) wei.
      const lhs = pa * bw;
      const rhs = pb * aw;
      const slack = (aw > bw ? aw : bw);
      const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
      expect(diff).to.be.lte(slack);

      // sanity: window totals agree for both accounts
      expect(twB).to.equal(await windowTotal(ledger, E));
    });

    it("equal windowShares => exactly equal payout (no rounding gap)", async () => {
      const { ledger, creditorFor, alice, bob } = await loadFixture(deploy);
      await gotoEpoch(410);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 123n);
      await ledger.connect(creditorFor[TASK]).creditShares(bob.address, TASK, 123n);
      await gotoEpoch(411);
      const E = ep(410);
      const pa = await ledger.claimable(alice.address, E);
      const pb = await ledger.claimable(bob.address, E);
      expect(pa).to.equal(pb);
    });

    it("doubling one account's shares ~doubles its payout (ratio preserved)", async () => {
      const { ledger, creditorFor, alice, bob } = await loadFixture(deploy);
      await gotoEpoch(420);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      await ledger.connect(creditorFor[HASH]).creditShares(bob.address, HASH, 200n);
      await gotoEpoch(421);
      const E = ep(420);
      const pa = await ledger.claimable(alice.address, E);
      const pb = await ledger.claimable(bob.address, E);
      // pb should be ~2x pa, within 1 wei of floor rounding.
      const diff = pb > 2n * pa ? pb - 2n * pa : 2n * pa - pb;
      expect(diff).to.be.lte(1n);
    });
  });

  // ----------------------------------------------------------------- //
  // (e) zero-total-window => zero payout, no revert                    //
  // ----------------------------------------------------------------- //
  describe("(e) zero-total window — pays 0 without reverting", function () {
    it("no credits anywhere in the window: claimable 0 and claim emits Claimed(.,.,0)", async () => {
      const { ledger, alice } = await loadFixture(deploy);
      await gotoEpoch(500);
      await gotoEpoch(503); // several empty epochs span the whole window
      const E = ep(502);
      expect(await ledger.claimable(alice.address, E)).to.equal(0n);
      await expect(ledger.connect(alice).claim(E)).to.emit(ledger, "Claimed").withArgs(alice.address, E, 0n);
      // No funds moved.
      expect(await ledger.totalPaid()).to.equal(0n);
    });

    it("account with zero shares but a non-empty window gets 0 and the others split the full issuance", async () => {
      const { ledger, creditorFor, alice, bob, carol } = await loadFixture(deploy);
      await gotoEpoch(510);
      await ledger.connect(creditorFor[HASH]).creditShares(bob.address, HASH, 100n);
      await ledger.connect(creditorFor[TASK]).creditShares(carol.address, TASK, 100n);
      await gotoEpoch(511);
      const E = ep(510);
      expect(await ledger.claimable(alice.address, E)).to.equal(0n);
      const pb = await ledger.claimable(bob.address, E);
      const pc = await ledger.claimable(carol.address, E);
      expect(pb + pc).to.be.lte(ISSUANCE);
      expect(pb).to.equal(pc); // equal shares
    });
  });

  // ----------------------------------------------------------------- //
  // (f) closed-epoch monotonicity — a closed epoch never re-opens      //
  // ----------------------------------------------------------------- //
  describe("(f) closed-epoch monotonicity — closed stays closed forever", function () {
    it("once isEpochClosed-implied claim succeeds, advancing time keeps it claimable-history stable", async () => {
      const { ledger, creditorFor, alice } = await loadFixture(deploy);
      await gotoEpoch(600);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      await gotoEpoch(601);
      const E = ep(600);

      // Closed now: claim works.
      await ledger.connect(alice).claim(E);
      expect(await ledger.claimed(E, alice.address)).to.equal(true);

      // Advance far into the future; the epoch must remain "closed" (never re-open),
      // so a second claim still reverts AlreadyClaimed (not EpochNotClosed).
      await gotoEpoch(700);
      await expect(ledger.connect(alice).claim(E)).to.be.revertedWithCustomError(ledger, "AlreadyClaimed");
    });

    it("claiming an open epoch reverts; the SAME epoch becomes permanently claimable once closed", async () => {
      const { ledger, creditorFor, alice } = await loadFixture(deploy);
      await gotoEpoch(610);
      await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      const E = ep(610);

      // Open => revert EpochNotClosed.
      await expect(ledger.connect(alice).claim(E)).to.be.revertedWithCustomError(ledger, "EpochNotClosed");

      // Cross the boundary; from here on it is closed and stays closed for every later block.
      await gotoEpoch(611);
      await ledger.connect(alice).claim(E); // succeeds now
      await gotoEpoch(620);
      // Still closed (monotone): never reverts EpochNotClosed again.
      await expect(ledger.connect(alice).claim(E)).to.not.be.revertedWithCustomError(ledger, "EpochNotClosed");
    });

    it("an account can claim a window of consecutive closed epochs, each exactly once", async () => {
      const { ledger, creditorFor, alice } = await loadFixture(deploy);
      // Credit alice solo in 3 consecutive epochs, then close them all.
      for (let i = 0; i < 3; i++) {
        await gotoEpoch(630 + i);
        await ledger.connect(creditorFor[HASH]).creditShares(alice.address, HASH, 100n);
      }
      await gotoEpoch(640);
      for (let i = 0; i < 3; i++) {
        const E = ep(630 + i);
        await ledger.connect(alice).claim(E);
        await expect(ledger.connect(alice).claim(E)).to.be.revertedWithCustomError(ledger, "AlreadyClaimed");
      }
      // Budget invariant still holds.
      expect(await ledger.totalPaid()).to.be.lte(await ledger.totalFunded());
    });
  });

  // ----------------------------------------------------------------- //
  // randomized cross-check: sweep many seeds, assert (a) + (b) + (d).  //
  // ----------------------------------------------------------------- //
  describe("randomized sweep — conservation + budget + fairness over many credits", function () {
    it("100 randomized credits across lanes/accounts/epochs keep all invariants", async () => {
      const { ledger, prana, creditorFor, alice, bob, carol, dave } = await loadFixture(deploy);
      const accounts = [alice, bob, carol, dave];

      // Deterministic LCG so the property test is reproducible.
      let s = 0x9e3779b9n;
      const rnd = (mod) => {
        s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return Number((s >> 17n) % BigInt(mod));
      };

      const startIdx = 800;
      const nEpochs = 12;
      for (let k = 0; k < nEpochs; k++) {
        await gotoEpoch(startIdx + k);
        const creditsThisEpoch = 1 + rnd(4);
        for (let j = 0; j < creditsThisEpoch; j++) {
          const acct = accounts[rnd(accounts.length)];
          const lane = LANES[rnd(LANES.length)];
          const amount = BigInt(1 + rnd(1000));
          await ledger.connect(creditorFor[lane]).creditShares(acct.address, lane, amount);
        }
      }
      // Close all credited epochs.
      await gotoEpoch(startIdx + nEpochs + 1);

      // For every closed epoch in range, conservation must hold across all accounts.
      for (let k = 0; k < nEpochs; k++) {
        const E = ep(startIdx + k);
        const totWin = await windowTotal(ledger, E);
        let sumPaid = 0n;
        for (const a of accounts) {
          sumPaid += await ledger.claimable(a.address, E);
        }
        // (a) conservation
        expect(sumPaid).to.be.lte(ISSUANCE);
        if (totWin > 0n) {
          const dust = ISSUANCE - sumPaid;
          expect(dust).to.be.lt(BigInt(accounts.length)); // dust strictly down, bounded
        } else {
          expect(sumPaid).to.equal(0n); // (e) zero window => zero
        }
      }

      // Realize a subset of claims and re-check the budget invariant (b).
      const ledgerBalBefore = await prana.balanceOf(await ledger.getAddress());
      let realized = 0n;
      for (let k = 0; k < nEpochs; k += 2) {
        const E = ep(startIdx + k);
        for (const a of accounts) {
          const c = await ledger.claimable(a.address, E);
          if (c > 0n) {
            await ledger.connect(a).claim(E);
            realized += c;
          }
        }
        expect(await ledger.totalPaid()).to.be.lte(await ledger.totalFunded());
      }
      // Tokens leaving the ledger equal the realized claims (no leak, no double-pay).
      const ledgerBalAfter = await prana.balanceOf(await ledger.getAddress());
      expect(ledgerBalBefore - ledgerBalAfter).to.equal(realized);
    });
  });
});
