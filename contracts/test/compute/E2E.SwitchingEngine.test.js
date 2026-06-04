const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// XX9 + PR3 — the "chain-as-pool switching engine" end-to-end.
//
// Wires the REAL stack:
//   UnifiedSharesLedger  <-- HashLaneCreditor (HASH lane)
//                        <-- TaskLaneCreditor (TASK lane, fed through the real
//                            TaskVerificationGate K-of-N quorum over AttestationStakeSlash)
//   HashTaskWeightConfig pins HASH:TASK = 1:1 (the seamless-switching default).
//
// Proves:
//   (a) a HASH share and a TASK share credited equally -> EQUAL payout (seamless switching).
//   (b) PR3 graceful degradation — with TASK shares == 0 in a window, 100% of epochIssuance
//       flows to the sole HASH worker (nothing is stranded / no idle issuance).
//   (c) when TASK demand returns, the split shifts pro-rata to the live HASH:TASK mix.

// Lane enum: HASH=0, TASK=1, BURN=2
const HASH = 0;
const TASK = 1;
const ONE = 10n ** 18n;

const EPOCH_LEN = 3600n; // 1 hour epochs
const WINDOW = 1n; // single-epoch window keeps each window's split self-contained
const ISSUANCE = 1000n * ONE; // 1000 PRANA per closed epoch

// Anchor readable epoch indices above the chain's real start epoch (same pattern as the ledger test).
let BASE = 1_000_000n; // re-anchored in deploy() above the live global clock (sibling suites advance it)
const ep = (n) => BASE + BigInt(n);

const MIN_STAKE = 100n * ONE;
const TASK_ID = ethers.id("hathor-inference");

describe("E2E switching engine (XX9 + PR3)", function () {
  async function deploy() {
    BASE = BigInt(await time.latest()) / EPOCH_LEN + 100n;
    const [admin, alice, bob, coord, att1, att2, att3] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

    // Lane weights: HASH=1e18, TASK=1e18 (pinned by ctor), BURN=1e18.
    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
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

    // --- HASH lane creditor (open mode: no beacon) ---
    const Hash = await ethers.getContractFactory("HashLaneCreditor");
    const hashCreditor = await Hash.deploy(await ledger.getAddress(), ethers.ZeroAddress, admin.address);

    // --- TASK lane: staking module -> verification gate -> task registry -> creditor ---
    const stakeTok = await Mock.deploy("Stake", "STK");
    const Att = await ethers.getContractFactory("AttestationStakeSlash");
    const attestation = await Att.deploy(
      await stakeTok.getAddress(),
      MIN_STAKE,
      admin.address, // treasury
      admin.address // admin/slasher
    );

    const Gate = await ethers.getContractFactory("TaskVerificationGate");
    const gate = await Gate.deploy(await attestation.getAddress(), admin.address);

    const Reg = await ethers.getContractFactory("TaskRegistry");
    const registry = await Reg.deploy(admin.address);
    // TASK weight = 1e18 (equal-to-hash); enabled.
    await registry.setTaskType(TASK_ID, ethers.ZeroHash, await gate.getAddress(), ONE, 0n, true);

    const Task = await ethers.getContractFactory("TaskLaneCreditor");
    const taskCreditor = await Task.deploy(
      await ledger.getAddress(),
      await registry.getAddress(),
      await gate.getAddress(),
      ethers.ZeroAddress, // no beacon (open mode)
      admin.address
    );

    // --- ROLE WIRING ---
    // ledger lane roles -> the two creditor modules.
    await ledger.grantRole(await ledger.HASH_CREDITOR(), await hashCreditor.getAddress());
    await ledger.grantRole(await ledger.TASK_CREDITOR(), await taskCreditor.getAddress());
    await ledger.grantRole(await ledger.FUNDER_ROLE(), admin.address);
    // the task creditor consumes verdicts from the gate.
    await gate.grantRole(await gate.CONSUMER_ROLE(), await taskCreditor.getAddress());
    // coordinator key may submit hash batches + settle verified tasks.
    await hashCreditor.grantRole(await hashCreditor.CREDITOR_ROLE(), coord.address);
    await taskCreditor.grantRole(await taskCreditor.CREDITOR_ROLE(), coord.address);

    // Fund the issuance budget generously.
    await prana.mint(admin.address, 1_000_000n * ONE);
    await prana.connect(admin).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(admin).fundEpoch(100_000n * ONE);

    // Stake the attestors so they are "active" in the gate.
    for (const a of [att1, att2, att3]) {
      await stakeTok.mint(a.address, MIN_STAKE);
      await stakeTok.connect(a).approve(await attestation.getAddress(), MIN_STAKE);
      await attestation.connect(a).stake(MIN_STAKE);
    }

    return {
      admin, alice, bob, coord, att1, att2, att3,
      prana, cfg, ledger, hashCreditor, taskCreditor, gate, registry, attestation,
    };
  }

  async function gotoEpoch(target) {
    const want = ep(target);
    const now = BigInt(await time.latest());
    const cur = now / EPOCH_LEN;
    if (want > cur) {
      await time.setNextBlockTimestamp(Number(want * EPOCH_LEN));
      await ethers.provider.send("evm_mine", []);
    }
  }

  // Drive a verified TASK credit through the REAL gate: open claim, K-of-N attest, then settle.
  async function creditVerifiedTask(ctx, { claimId, worker, baseShares, attestors, k }) {
    const { gate, taskCreditor, coord, admin } = ctx;
    const attAddrs = attestors.map((a) => a.address);
    await gate.connect(admin).openClaim(claimId, worker.address, k, attAddrs);
    for (let i = 0; i < k; i++) {
      await gate.connect(attestors[i]).attest(claimId);
    }
    expect(await gate.isVerified(claimId)).to.equal(true);
    await taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, baseShares);
  }

  describe("(a) seamless switching: HASH and TASK credited equally pay equally", function () {
    it("a hashed share and a tasked share earn the same PRANA", async () => {
      const ctx = await loadFixture(deploy);
      const { ledger, hashCreditor, coord, alice, bob, att1, att2 } = ctx;

      await gotoEpoch(10);
      const e = ep(10);

      // Alice earns via HASH: 100 normalized shares.
      await hashCreditor
        .connect(coord)
        .submitBatch(e, ethers.id("batch-10"), [alice.address], [100n]);

      // Bob earns via TASK: a verified completion worth 100 base shares (1:1 weight -> 100 pooled).
      await creditVerifiedTask(ctx, {
        claimId: ethers.id("claim-10-bob"),
        worker: bob,
        baseShares: 100n,
        attestors: [att1, att2],
        k: 2,
      });

      // Both lanes pooled 100 shares at 1:1 weight.
      expect(await ledger.poolShares(e, alice.address)).to.equal(100n);
      expect(await ledger.poolShares(e, bob.address)).to.equal(100n);

      // Close the epoch and claim.
      await gotoEpoch(11);
      // window [e,e]; tot = 200; each 50% -> ISSUANCE/2.
      const half = ISSUANCE / 2n;
      expect(await ledger.claimable(alice.address, e)).to.equal(half);
      expect(await ledger.claimable(bob.address, e)).to.equal(half);
      // EQUAL payout — the switching engine is seamless.
      expect(await ledger.claimable(alice.address, e)).to.equal(await ledger.claimable(bob.address, e));
    });
  });

  describe("(b) PR3 graceful degradation: zero TASK demand strands nothing", function () {
    it("with TASK shares == 0, 100% of issuance flows to the sole HASH worker", async () => {
      const ctx = await loadFixture(deploy);
      const { ledger, prana, hashCreditor, coord, alice } = ctx;

      await gotoEpoch(20);
      const e = ep(20);

      // No AI demand this window: ONLY a hash batch lands (TASK lane stays empty).
      await hashCreditor
        .connect(coord)
        .submitBatch(e, ethers.id("batch-20"), [alice.address], [100n]);

      // total pooled == hash-only.
      expect(await ledger.totalSharesAt(e)).to.equal(100n);

      await gotoEpoch(21);
      // sole worker takes the FULL epoch issuance — nothing stranded, no idle issuance.
      expect(await ledger.claimable(alice.address, e)).to.equal(ISSUANCE);

      const before = await prana.balanceOf(alice.address);
      await ledger.connect(alice).claim(e);
      expect((await prana.balanceOf(alice.address)) - before).to.equal(ISSUANCE);
      expect(await ledger.totalPaid()).to.equal(ISSUANCE);
    });
  });

  describe("(c) demand returns: split shifts pro-rata to the live mix", function () {
    it("HASH-only window pays 100% HASH; mixed window splits pro-rata", async () => {
      const ctx = await loadFixture(deploy);
      const { ledger, hashCreditor, coord, alice, bob, att1, att2, att3 } = ctx;

      // --- window @30: HASH-only (degraded). Alice 100 HASH. ---
      await gotoEpoch(30);
      const e30 = ep(30);
      await hashCreditor
        .connect(coord)
        .submitBatch(e30, ethers.id("batch-30"), [alice.address], [100n]);

      // --- window @31: TASK demand RETURNS. Alice 100 HASH, Bob 300 TASK. ---
      await gotoEpoch(31);
      const e31 = ep(31);
      await hashCreditor
        .connect(coord)
        .submitBatch(e31, ethers.id("batch-31"), [alice.address], [100n]);
      await creditVerifiedTask(ctx, {
        claimId: ethers.id("claim-31-bob"),
        worker: bob,
        baseShares: 300n,
        attestors: [att1, att2, att3],
        k: 3,
      });

      // close both windows.
      await gotoEpoch(32);

      // window @30 (single-epoch window): HASH-only -> Alice takes 100%.
      expect(await ledger.claimable(alice.address, e30)).to.equal(ISSUANCE);
      expect(await ledger.claimable(bob.address, e30)).to.equal(0n);

      // window @31: tot = 100 (HASH) + 300 (TASK) = 400.
      //   Alice 100/400 = 25% ; Bob 300/400 = 75%.
      const expAlice = (ISSUANCE * 100n) / 400n;
      const expBob = (ISSUANCE * 300n) / 400n;
      expect(await ledger.claimable(alice.address, e31)).to.equal(expAlice);
      expect(await ledger.claimable(bob.address, e31)).to.equal(expBob);
      expect(expAlice + expBob).to.equal(ISSUANCE); // whole issuance distributed, none stranded
    });
  });

  describe("verification gate is load-bearing for TASK credit", function () {
    it("an unverified claim cannot be settled into the pool", async () => {
      const ctx = await loadFixture(deploy);
      const { gate, taskCreditor, coord, admin, bob, att1, att2 } = ctx;

      await gotoEpoch(40);
      const claimId = ethers.id("claim-40-unverified");
      await gate.connect(admin).openClaim(claimId, bob.address, 2, [att1.address, att2.address]);
      // only ONE attestation -> below K -> not verified.
      await gate.connect(att1).attest(claimId);
      expect(await gate.isVerified(claimId)).to.equal(false);

      await expect(
        taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, 100n)
      ).to.be.revertedWithCustomError(gate, "NotVerified");
    });

    it("a verified verdict is one-shot: cannot be credited twice", async () => {
      const ctx = await loadFixture(deploy);
      const { gate, taskCreditor, coord, bob, att1, att2 } = ctx;

      await gotoEpoch(41);
      const claimId = ethers.id("claim-41-bob");
      await creditVerifiedTask(ctx, {
        claimId,
        worker: bob,
        baseShares: 50n,
        attestors: [att1, att2],
        k: 2,
      });
      // replay the same verdict -> consume() reverts AlreadyConsumed.
      await expect(
        taskCreditor.connect(coord).creditVerified(claimId, TASK_ID, 50n)
      ).to.be.revertedWithCustomError(gate, "AlreadyConsumed");
    });
  });
});
