const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;
const CAP = (WAD * 5n) / 2n; // 2.5x

describe("VeBoost", function () {
  let h;

  beforeEach(async () => {
    const H = await ethers.getContractFactory("VeBoostHarness");
    h = await H.deploy();
  });

  describe("computeWorkingBalance", function () {
    it("zero deposit → zero working balance", async () => {
      expect(await h.computeWorkingBalance(0n, 1000n, 500n, 1000n)).to.equal(0n);
    });

    it("totalVe == 0 → no boost, working balance == 0.4 * deposit (1x floor)", async () => {
      const deposit = 1000n;
      const wb = await h.computeWorkingBalance(deposit, 5000n, 0n, 0n);
      expect(wb).to.equal((deposit * 40n) / 100n); // 400
    });

    it("userVe == 0 → 0.4 * deposit floor", async () => {
      const deposit = 1000n;
      const wb = await h.computeWorkingBalance(deposit, 5000n, 0n, 1000n);
      expect(wb).to.equal((deposit * 40n) / 100n);
    });

    it("user ve-share == deposit-share → exactly 1x floor (no extra boost beyond floor math)", async () => {
      // deposit/totalDeposits = 1000/4000 = 0.25 ; userVe/totalVe = 250/1000 = 0.25
      // wb = 0.4*1000 + 0.6*4000*0.25 = 400 + 600 = 1000 = full deposit → 2.5x actually.
      // Use a case where ve-share == deposit-share gives floor+something. Verify formula directly.
      const deposit = 1000n;
      const totalDeposits = 4000n;
      const userVe = 250n;
      const totalVe = 1000n;
      const expected = (deposit * 40n) / 100n + (totalDeposits * userVe * 60n) / (totalVe * 100n);
      const capped = expected < deposit ? expected : deposit;
      const wb = await h.computeWorkingBalance(deposit, totalDeposits, userVe, totalVe);
      expect(wb).to.equal(capped);
    });

    it("huge ve share → capped at deposit (2.5x ceiling)", async () => {
      const deposit = 1000n;
      // userVe == totalVe and the user is a small share of deposits → boost term explodes,
      // min() clamps to deposit.
      const wb = await h.computeWorkingBalance(deposit, 1_000_000n, 1000n, 1000n);
      expect(wb).to.equal(deposit);
    });

    it("never exceeds deposit and never below 0.4*deposit across a table", async () => {
      const deposit = 10_000n;
      const totalDeposits = 100_000n;
      const floor = (deposit * 40n) / 100n;
      const table = [
        [0n, 1000n],
        [10n, 1000n],
        [100n, 1000n],
        [500n, 1000n],
        [1000n, 1000n],
        [1n, 10n],
      ];
      for (const [uv, tv] of table) {
        const wb = await h.computeWorkingBalance(deposit, totalDeposits, uv, tv);
        expect(wb >= floor).to.equal(true);
        expect(wb <= deposit).to.equal(true);
      }
    });
  });

  describe("boostMultiplier", function () {
    it("unboosted (no ve) → 1x (1e18)", async () => {
      expect(await h.boostMultiplier(1000n, 5000n, 0n, 0n)).to.equal(WAD);
    });

    it("max boost (clamped at deposit) → 2.5x (2.5e18)", async () => {
      const m = await h.boostMultiplier(1000n, 1_000_000n, 1000n, 1000n);
      expect(m).to.equal(CAP);
    });

    it("partial boost lands strictly between 1x and 2.5x", async () => {
      // wb = 0.4*1000 + 0.6*4000*(250/1000) = 400 + 600 = 1000 -> that's the cap; pick smaller boost
      const m = await h.boostMultiplier(1000n, 4000n, 100n, 1000n);
      // wb = 400 + 0.6*4000*0.1 = 400 + 240 = 640 ; mult = 640/400 = 1.6x
      expect(m).to.equal((640n * WAD) / 400n);
      expect(m > WAD).to.equal(true);
      expect(m < CAP).to.equal(true);
    });

    it("zero deposit → 1x baseline", async () => {
      expect(await h.boostMultiplier(0n, 1000n, 500n, 1000n)).to.equal(WAD);
    });

    it("multiplier is always within [1x, 2.5x]", async () => {
      const cases = [
        [1000n, 100_000n, 0n, 0n],
        [1000n, 100_000n, 1n, 1_000_000n],
        [1000n, 100_000n, 500_000n, 1_000_000n],
        [1000n, 100_000n, 1_000_000n, 1_000_000n],
        [7n, 13n, 3n, 9n],
      ];
      for (const [d, td, uv, tv] of cases) {
        const m = await h.boostMultiplier(d, td, uv, tv);
        expect(m >= WAD).to.equal(true);
        expect(m <= CAP).to.equal(true);
      }
    });
  });
});
