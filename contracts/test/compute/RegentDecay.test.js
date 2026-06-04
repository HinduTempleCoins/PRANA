const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// XX8 — RegentGovernance decaying founder weight (BLURT @regent model).
//
// Properties proven here:
//   * weight decays LINEARLY from initialWeight to exactly ZERO over `duration`,
//   * is correct at t<=start (full), midpoint (half), end (0), past-end (clamped at 0),
//   * is monotonic non-increasing in time,
//   * is exposed verbatim through RegentVotesAdapter as IVotes (getVotes / getPastVotes /
//     getPastTotalSupply),
//   * decay is VOTE WEIGHT ONLY — the contract holds no token, has no supply/emission/reward
//     surface, so decaying weight can never touch circulating supply.

const ONE = 10n ** 18n;

const INITIAL = 1_000_000n * ONE; // genesis controlling regent weight
const DURATION = 2n * 365n * 24n * 3600n; // ~2yr, 24-month BLURT-style schedule

describe("RegentDecay (XX8) — decaying founder weight", function () {
  async function deploy() {
    const [admin, regentAccount, other] = await ethers.getSigners();

    // Start the schedule comfortably in the FUTURE so the "live horizon" test can warp forward
    // through start -> mid -> end (the global hardhat clock only moves forward; a start==now is
    // already in the past after the fixture's own deploy blocks, making setNextBlockTimestamp throw
    // "timestamp lower than previous"). Pure weightAt() checks are start-relative, unaffected.
    const startTs = BigInt(await time.latest()) + 3600n;
    const Regent = await ethers.getContractFactory("RegentGovernance");
    const regent = await Regent.deploy(admin.address, INITIAL, startTs, DURATION);

    const start = await regent.start();
    const end = await regent.end();

    const Adapter = await ethers.getContractFactory("RegentVotesAdapter");
    // regentAccount carries the weight; everyone else reads 0.
    const adapter = await Adapter.deploy(await regent.getAddress(), regentAccount.address);

    return { admin, regentAccount, other, regent, adapter, start, end };
  }

  describe("linear decay curve", function () {
    it("full weight at and before start", async () => {
      const { regent, start } = await loadFixture(deploy);
      expect(await regent.weightAt(start)).to.equal(INITIAL);
      expect(await regent.weightAt(start - 1n)).to.equal(INITIAL); // pre-start clamps to full
      expect(await regent.weightAt(0n)).to.equal(INITIAL);
    });

    it("exactly half weight at the midpoint", async () => {
      const { regent, start } = await loadFixture(deploy);
      const mid = start + DURATION / 2n;
      // weight = INITIAL * (end - mid) / duration = INITIAL * (duration/2) / duration = INITIAL/2.
      expect(await regent.weightAt(mid)).to.equal(INITIAL / 2n);
    });

    it("decays linearly at arbitrary fractions of the horizon", async () => {
      const { regent, start, end } = await loadFixture(deploy);
      // Check a spread of fractions match the closed-form INITIAL*(end-t)/duration.
      for (const num of [1n, 3n, 7n, 9n, 99n]) {
        const den = 100n;
        const t = start + (DURATION * num) / den;
        const expected = (INITIAL * (end - t)) / DURATION;
        expect(await regent.weightAt(t)).to.equal(expected);
      }
    });

    it("exactly ZERO at end and clamped at 0 past-end (forever)", async () => {
      const { regent, end } = await loadFixture(deploy);
      expect(await regent.weightAt(end)).to.equal(0n);
      expect(await regent.weightAt(end + 1n)).to.equal(0n);
      expect(await regent.weightAt(end + DURATION * 100n)).to.equal(0n);
    });

    it("weight() tracks block.timestamp across the live horizon (start -> mid -> end)", async () => {
      const { regent, start, end } = await loadFixture(deploy);

      // live at start.
      await time.setNextBlockTimestamp(Number(start));
      await ethers.provider.send("evm_mine", []);
      expect(await regent.weight()).to.equal(INITIAL);

      // live at midpoint.
      await time.setNextBlockTimestamp(Number(start + DURATION / 2n));
      await ethers.provider.send("evm_mine", []);
      expect(await regent.weight()).to.equal(INITIAL / 2n);

      // live at/after end -> 0.
      await time.setNextBlockTimestamp(Number(end + 10n));
      await ethers.provider.send("evm_mine", []);
      expect(await regent.weight()).to.equal(0n);
    });
  });

  describe("monotonic non-increasing", function () {
    it("never increases as time advances across the whole horizon", async () => {
      const { regent, start } = await loadFixture(deploy);
      let prev = INITIAL + 1n;
      const steps = 40n;
      for (let i = 0n; i <= steps; i++) {
        const t = start + (DURATION * i) / steps;
        const w = await regent.weightAt(t);
        expect(w).to.be.lte(prev); // monotone non-increasing
        expect(w).to.be.lte(INITIAL); // never above genesis weight
        prev = w;
      }
      // final sample is exactly 0 (i == steps -> t == end).
      expect(prev).to.equal(0n);
    });
  });

  describe("exposed as IVotes via RegentVotesAdapter", function () {
    it("getVotes returns the live decayed weight for the regent account, 0 for others", async () => {
      const { regent, adapter, regentAccount, other, start } = await loadFixture(deploy);

      await time.setNextBlockTimestamp(Number(start + DURATION / 4n));
      await ethers.provider.send("evm_mine", []);

      const live = await regent.weight();
      expect(await adapter.getVotes(regentAccount.address)).to.equal(live);
      expect(await adapter.getVotes(other.address)).to.equal(0n);
    });

    it("getPastVotes recomputes the schedule at a past timepoint (and 0 for non-regent)", async () => {
      const { regent, adapter, regentAccount, other, start } = await loadFixture(deploy);

      const past = start + DURATION / 2n;
      // advance well beyond `past` so it is strictly in the past.
      await time.setNextBlockTimestamp(Number(start + (DURATION * 3n) / 4n));
      await ethers.provider.send("evm_mine", []);

      expect(await adapter.getPastVotes(regentAccount.address, past)).to.equal(await regent.weightAt(past));
      expect(await adapter.getPastVotes(other.address, past)).to.equal(0n);
      // total supply == the regent's weight at that timepoint (only the regent contributes).
      expect(await adapter.getPastTotalSupply(past)).to.equal(await regent.weightAt(past));
    });

    it("getPastVotes provably returns 0 at/after end", async () => {
      const { regent, adapter, regentAccount, end } = await loadFixture(deploy);
      // move past end so the lookup is in the past.
      await time.setNextBlockTimestamp(Number(end + 1000n));
      await ethers.provider.send("evm_mine", []);
      expect(await adapter.getPastVotes(regentAccount.address, end)).to.equal(0n);
      expect(await adapter.getPastTotalSupply(end)).to.equal(0n);
    });

    it("future-timepoint lookups revert (mirrors OZ Votes semantics)", async () => {
      const { adapter, regentAccount } = await loadFixture(deploy);
      const future = BigInt(await time.latest()) + 10_000n;
      await expect(adapter.getPastVotes(regentAccount.address, future)).to.be.revertedWithCustomError(
        adapter,
        "FutureLookup"
      );
      await expect(adapter.getPastTotalSupply(future)).to.be.revertedWithCustomError(adapter, "FutureLookup");
    });

    it("runs the Governor in EIP-6372 TIMESTAMP mode (schedule is in seconds)", async () => {
      const { adapter } = await loadFixture(deploy);
      expect(await adapter.CLOCK_MODE()).to.equal("mode=timestamp");
      const now = BigInt(await time.latest());
      // clock() == block.timestamp (timestamp mode), within a tick of `now`.
      expect(await adapter.clock()).to.be.gte(now);
    });
  });

  describe("early renounce forces weight to 0 forever", function () {
    it("renouncing zeroes live weight and all timepoints", async () => {
      const { regent, adapter, regentAccount, admin, start } = await loadFixture(deploy);
      // sit mid-horizon with meaningful weight, snapshot the timepoint.
      await time.setNextBlockTimestamp(Number(start + DURATION / 2n));
      await ethers.provider.send("evm_mine", []);
      expect(await regent.weight()).to.equal(INITIAL / 2n);

      await regent.connect(admin).renounce();
      expect(await regent.renounced()).to.equal(true);

      // live and historical weight all collapse to 0.
      expect(await regent.weight()).to.equal(0n);
      const before = start + DURATION / 4n;
      expect(await regent.weightAt(before)).to.equal(0n);
      expect(await adapter.getVotes(regentAccount.address)).to.equal(0n);

      // a past lookup also reads 0 after renounce.
      await time.setNextBlockTimestamp(Number(start + (DURATION * 3n) / 4n));
      await ethers.provider.send("evm_mine", []);
      expect(await adapter.getPastVotes(regentAccount.address, before)).to.equal(0n);
    });
  });

  describe("STEERING NOT EXTRACTION — decay is vote weight only", function () {
    it("the regent contract has NO supply/emission/reward/value surface", async () => {
      const { regent } = await loadFixture(deploy);
      const iface = regent.interface;
      const fnNames = iface.fragments.filter((f) => f.type === "function").map((f) => f.name);

      // No function may move value or touch supply/emission/rewards.
      const forbidden = [
        "mint",
        "burn",
        "transfer",
        "transferFrom",
        "approve",
        "withdraw",
        "claim",
        "fund",
        "fundEpoch",
        "reward",
        "distribute",
        "setIssuance",
        "setEpochIssuance",
      ];
      for (const f of forbidden) {
        expect(fnNames, `RegentGovernance must not expose ${f}()`).to.not.include(f);
      }

      // No payable function (cannot receive value).
      const payable = iface.fragments.filter(
        (f) => f.type === "function" && (f.stateMutability === "payable")
      );
      expect(payable.length, "RegentGovernance must have no payable functions").to.equal(0);

      // The whole mutating surface is exactly renounce/transferAdmin (steering custody only).
      const nonView = iface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(nonView).to.deep.equal(["renounce", "transferAdmin"]);
    });

    it("decay changes vote weight but the adapter holds/moves no token either", async () => {
      const { adapter } = await loadFixture(deploy);
      const fnNames = adapter.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      // delegate/delegateBySig exist (IVotes) but are inert; no value movement surface.
      for (const f of ["mint", "transfer", "transferFrom", "withdraw", "claim", "fundEpoch"]) {
        expect(fnNames).to.not.include(f);
      }
    });
  });
});
