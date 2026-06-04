const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Lane enum: HASH=0, TASK=1, BURN=2
const HASH = 0;
const TASK = 1;
const BURN = 2;
const ONE = 10n ** 18n;

const EPOCH_LEN = 3600n; // 1 hour epochs
const WINDOW = 2n; // PPLNS trailing window = 2 epochs
const ISSUANCE = 1000n * ONE; // 1000 PRANA per closed epoch

// Hardhat's chain clock is GLOBAL and monotonic across the whole test run — sibling compute suites
// advance it far forward before this file runs. So a hardcoded BASE can fall BELOW "now" and make
// gotoEpoch() a silent no-op. BASE is therefore re-anchored DYNAMICALLY above the live clock inside
// deploy() (which loadFixture runs/snapshots once), and ep(n) is the absolute epoch the contract sees.
let BASE = 1_000_000n;
const ep = (n) => BASE + BigInt(n);

describe("UnifiedSharesLedger (NN1)", function () {
  async function deploy() {
    const [admin, alice, bob, carol, hashCred, taskCred, burnCred, funder] = await ethers.getSigners();

    // Re-anchor BASE comfortably above wherever the global clock sits when this suite first runs.
    BASE = BigInt(await time.latest()) / EPOCH_LEN + 100n;

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    // burn weight defaults to 1x here (changed in a dedicated test)
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

    // Grant lane creditor roles.
    await ledger.grantRole(await ledger.HASH_CREDITOR(), hashCred.address);
    await ledger.grantRole(await ledger.TASK_CREDITOR(), taskCred.address);
    await ledger.grantRole(await ledger.BURN_CREDITOR(), burnCred.address);
    await ledger.grantRole(await ledger.FUNDER_ROLE(), funder.address);

    // Fund the budget generously.
    await prana.mint(funder.address, 1_000_000n * ONE);
    await prana.connect(funder).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(funder).fundEpoch(100_000n * ONE);

    return { admin, alice, bob, carol, hashCred, taskCred, burnCred, funder, prana, cfg, ledger };
  }

  // Advance to the start of a target epoch index (epochs are absolute block.timestamp / EPOCH_LEN).
  async function gotoEpoch(target) {
    const want = ep(target); // anchor the readable index above the chain's start epoch
    const now = BigInt(await time.latest());
    const cur = now / EPOCH_LEN;
    if (want > cur) {
      await time.setNextBlockTimestamp(Number(want * EPOCH_LEN));
      await ethers.provider.send("evm_mine", []);
    }
  }

  describe("deployment & config", function () {
    it("exposes epochLength / windowEpochs / epochIssuance", async () => {
      const { ledger } = await loadFixture(deploy);
      expect(await ledger.epochLength()).to.equal(EPOCH_LEN);
      expect(await ledger.windowEpochs()).to.equal(WINDOW);
      expect(await ledger.epochIssuance()).to.equal(ISSUANCE);
    });

    it("rejects zero epoch length / window / addresses", async () => {
      const [admin] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const prana = await Mock.deploy("Prana", "PRANA");
      const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
      const cfg = await Cfg.deploy(admin.address, ONE, 1n, 10n);
      const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");

      await expect(
        Ledger.deploy(await prana.getAddress(), await cfg.getAddress(), admin.address, 0n, WINDOW, ISSUANCE)
      ).to.be.revertedWithCustomError(Ledger, "ZeroEpochLength");
      await expect(
        Ledger.deploy(await prana.getAddress(), await cfg.getAddress(), admin.address, EPOCH_LEN, 0n, ISSUANCE)
      ).to.be.revertedWithCustomError(Ledger, "ZeroWindow");
      await expect(
        Ledger.deploy(ethers.ZeroAddress, await cfg.getAddress(), admin.address, EPOCH_LEN, WINDOW, ISSUANCE)
      ).to.be.revertedWithCustomError(Ledger, "ZeroAddress");
    });
  });

  describe("crediting & role gating", function () {
    it("credits shares per lane only from the matching creditor role", async () => {
      const { ledger, hashCred, taskCred, burnCred, alice } = await loadFixture(deploy);

      const e = (BigInt(await time.latest())) / EPOCH_LEN;
      await expect(ledger.connect(hashCred).creditShares(alice.address, HASH, 100n))
        .to.emit(ledger, "SharesCredited")
        .withArgs(e, HASH, alice.address, 100n);
      await ledger.connect(taskCred).creditShares(alice.address, TASK, 50n);
      await ledger.connect(burnCred).creditShares(alice.address, BURN, 25n);

      // 1x weight everywhere -> 175 pooled this epoch.
      expect(await ledger.totalSharesAt(e)).to.equal(175n);
      expect(await ledger.poolShares(e, alice.address)).to.equal(175n);
    });

    it("rejects crediting a lane without that lane's role", async () => {
      const { ledger, hashCred, alice } = await loadFixture(deploy);
      // hashCred holds only HASH; crediting TASK must revert.
      await expect(ledger.connect(hashCred).creditShares(alice.address, TASK, 100n)).to.be.reverted;
    });

    it("rejects zero amount and zero account", async () => {
      const { ledger, hashCred, alice } = await loadFixture(deploy);
      await expect(ledger.connect(hashCred).creditShares(alice.address, HASH, 0n)).to.be.revertedWithCustomError(
        ledger,
        "ZeroAmount"
      );
      await expect(ledger.connect(hashCred).creditShares(ethers.ZeroAddress, HASH, 1n)).to.be.revertedWithCustomError(
        ledger,
        "ZeroAddress"
      );
    });
  });

  describe("lane weight application", function () {
    it("applies the governed BURN lane weight when pooling", async () => {
      const { ledger, cfg, admin, burnCred, alice } = await loadFixture(deploy);
      // Set BURN weight to 0.5x.
      await cfg.connect(admin).setLaneWeight(BURN, ONE / 2n);
      const e = (BigInt(await time.latest())) / EPOCH_LEN;
      await ledger.connect(burnCred).creditShares(alice.address, BURN, 100n);
      // 100 * 0.5 = 50 pooled.
      expect(await ledger.poolShares(e, alice.address)).to.equal(50n);
    });

    it("HASH and TASK pool 1:1 by default (seamless switching)", async () => {
      const { ledger, hashCred, taskCred, alice, bob } = await loadFixture(deploy);
      const e = (BigInt(await time.latest())) / EPOCH_LEN;
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      await ledger.connect(taskCred).creditShares(bob.address, TASK, 100n);
      expect(await ledger.poolShares(e, alice.address)).to.equal(await ledger.poolShares(e, bob.address));
    });

    it("reverts if weight rounds the credit to zero pooled shares", async () => {
      const { ledger, cfg, admin, burnCred, alice } = await loadFixture(deploy);
      await cfg.connect(admin).setLaneWeight(BURN, 1n); // ~1e-18 x
      // 1 * 1 / 1e18 = 0.
      await expect(ledger.connect(burnCred).creditShares(alice.address, BURN, 1n)).to.be.revertedWithCustomError(
        ledger,
        "ZeroAmount"
      );
    });
  });

  describe("PPLNS window math & pro-rata payout", function () {
    it("single-epoch window: sole creditor takes full issuance", async () => {
      const { ledger, hashCred, alice } = await loadFixture(deploy);
      await gotoEpoch(10);
      const e = ep(10);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);

      // close epoch 10.
      await gotoEpoch(11);
      // window [9,10] but only epoch 10 has shares -> alice is the only one.
      expect(await ledger.claimable(alice.address, e)).to.equal(ISSUANCE);

      await expect(ledger.connect(alice).claim(e)).to.emit(ledger, "Claimed").withArgs(alice.address, e, ISSUANCE);
    });

    it("splits issuance pro-rata to window share totals across two epochs", async () => {
      const { ledger, hashCred, taskCred, alice, bob } = await loadFixture(deploy);

      // Epoch 20: Alice HASH 100.
      await gotoEpoch(20);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);

      // Epoch 21: Bob TASK 300.
      await gotoEpoch(21);
      await ledger.connect(taskCred).creditShares(bob.address, TASK, 300n);

      // Close epoch 21.
      await gotoEpoch(22);

      // --- epoch 20 claim: window [19,20] -> only epoch 20 counts. tot=100, alice=100 -> full.
      expect(await ledger.claimable(alice.address, ep(20))).to.equal(ISSUANCE);

      // --- epoch 21 claim: window [20,21]. tot = 100 + 300 = 400.
      //     alice window = 100 -> 1000 * 100/400 = 250.
      //     bob   window = 300 -> 1000 * 300/400 = 750.
      const expAlice21 = (ISSUANCE * 100n) / 400n;
      const expBob21 = (ISSUANCE * 300n) / 400n;
      expect(await ledger.claimable(alice.address, ep(21))).to.equal(expAlice21);
      expect(await ledger.claimable(bob.address, ep(21))).to.equal(expBob21);

      // windowShares view sanity.
      const [aw, tw] = await ledger.windowShares(alice.address, ep(21));
      expect(aw).to.equal(100n);
      expect(tw).to.equal(400n);
    });

    it("old epochs drop out of the trailing window", async () => {
      const { ledger, hashCred, alice, bob } = await loadFixture(deploy);

      // Epoch 30: Alice 100.
      await gotoEpoch(30);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      // Epoch 31: Bob 100.
      await gotoEpoch(31);
      await ledger.connect(hashCred).creditShares(bob.address, HASH, 100n);
      // Epoch 32: nobody.
      await gotoEpoch(32);
      await ledger.connect(hashCred).creditShares(bob.address, HASH, 100n);
      // Close epoch 32.
      await gotoEpoch(33);

      // Window for epoch 32 = [31,32]. Epoch 30 (alice) is OUT of window.
      // tot = bob(31)=100 + bob(32)=100 = 200. alice window = 0.
      expect(await ledger.claimable(alice.address, ep(32))).to.equal(0n);
      expect(await ledger.claimable(bob.address, ep(32))).to.equal(ISSUANCE);
    });

    it("zero total shares in window -> zero payout, no revert", async () => {
      const { ledger, alice } = await loadFixture(deploy);
      await gotoEpoch(40);
      // close epoch 40 with no credits.
      await gotoEpoch(41);
      expect(await ledger.claimable(alice.address, ep(40))).to.equal(0n);
      await expect(ledger.connect(alice).claim(ep(40))).to.emit(ledger, "Claimed").withArgs(alice.address, ep(40), 0n);
    });
  });

  describe("claim mechanics", function () {
    it("reverts claiming an open (not-yet-closed) epoch", async () => {
      const { ledger, hashCred, alice } = await loadFixture(deploy);
      await gotoEpoch(50);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      // epoch 50 still current/open.
      await expect(ledger.connect(alice).claim(ep(50))).to.be.revertedWithCustomError(ledger, "EpochNotClosed");
    });

    it("is idempotent: double-claim reverts and pays once", async () => {
      const { ledger, prana, hashCred, alice } = await loadFixture(deploy);
      await gotoEpoch(60);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      await gotoEpoch(61);

      const before = await prana.balanceOf(alice.address);
      await ledger.connect(alice).claim(ep(60));
      const after = await prana.balanceOf(alice.address);
      expect(after - before).to.equal(ISSUANCE);

      await expect(ledger.connect(alice).claim(ep(60))).to.be.revertedWithCustomError(ledger, "AlreadyClaimed");
      // claimable now 0.
      expect(await ledger.claimable(alice.address, ep(60))).to.equal(0n);
    });

    it("transfers PRANA out and tracks totalPaid", async () => {
      const { ledger, prana, hashCred, taskCred, alice, bob } = await loadFixture(deploy);
      await gotoEpoch(70);
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      await ledger.connect(taskCred).creditShares(bob.address, TASK, 100n);
      await gotoEpoch(71);

      await ledger.connect(alice).claim(ep(70));
      await ledger.connect(bob).claim(ep(70));

      // window [69,70]; tot=200; each 50% -> ISSUANCE/2 each.
      const half = ISSUANCE / 2n;
      expect(await prana.balanceOf(alice.address)).to.equal(half);
      expect(await prana.balanceOf(bob.address)).to.equal(half);
      expect(await ledger.totalPaid()).to.equal(ISSUANCE);
    });

    it("reverts when the budget is insufficient", async () => {
      const [admin, alice, , , hashCred, , , funder] = await ethers.getSigners();
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
      await ledger.grantRole(await ledger.HASH_CREDITOR(), hashCred.address);
      await ledger.grantRole(await ledger.FUNDER_ROLE(), funder.address);
      // Fund LESS than one epoch issuance.
      await prana.mint(funder.address, 10n * ONE);
      await prana.connect(funder).approve(await ledger.getAddress(), ethers.MaxUint256);
      await ledger.connect(funder).fundEpoch(10n * ONE);

      const now = BigInt(await time.latest());
      const e = now / EPOCH_LEN;
      await ledger.connect(hashCred).creditShares(alice.address, HASH, 100n);
      await time.setNextBlockTimestamp(Number((e + 1n) * EPOCH_LEN));
      await ethers.provider.send("evm_mine", []);

      await expect(ledger.connect(alice).claim(e)).to.be.revertedWithCustomError(ledger, "InsufficientFunds");
    });
  });

  describe("funding & issuance accounting", function () {
    it("fundEpoch pulls PRANA and bumps totalFunded; only FUNDER_ROLE", async () => {
      const { ledger, prana, funder, alice } = await loadFixture(deploy);
      const start = await ledger.totalFunded();
      await ledger.connect(funder).fundEpoch(5n * ONE);
      expect(await ledger.totalFunded()).to.equal(start + 5n * ONE);

      await prana.mint(alice.address, ONE);
      await prana.connect(alice).approve(await ledger.getAddress(), ethers.MaxUint256);
      await expect(ledger.connect(alice).fundEpoch(ONE)).to.be.reverted;
    });

    it("ISSUANCE_ADMIN can change issuance and window", async () => {
      const { ledger, admin } = await loadFixture(deploy);
      await expect(ledger.connect(admin).setEpochIssuance(2000n * ONE))
        .to.emit(ledger, "EpochIssuanceSet")
        .withArgs(2000n * ONE);
      expect(await ledger.epochIssuance()).to.equal(2000n * ONE);

      await expect(ledger.connect(admin).setWindowEpochs(5n)).to.emit(ledger, "WindowEpochsSet").withArgs(5n);
      expect(await ledger.windowEpochs()).to.equal(5n);

      await expect(ledger.connect(admin).setWindowEpochs(0n)).to.be.revertedWithCustomError(ledger, "ZeroWindow");
    });

    it("non-admin cannot change issuance", async () => {
      const { ledger, alice } = await loadFixture(deploy);
      await expect(ledger.connect(alice).setEpochIssuance(1n)).to.be.reverted;
    });
  });
});
