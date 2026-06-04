const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const TASK = 1; // Lane.TASK
const PREFERENCE_RANK = 0;

const EPOCH_LEN = 3600n;
const WINDOW = 2n;
const ISSUANCE = 1000n * ONE;
const MIN_STAKE = 1000n;

const TASK_ID = ethers.id("rlhf-preference-v1");
const SPEC = ethers.id("spec-blob");
const PROV = ethers.id("captcha-of-record");

// Dynamic epoch anchor (the hardhat clock is global/monotonic across the run — see ledger test).
let EBASE = 1_000_000n;
const ep = (n) => EBASE + BigInt(n);

describe("E2E: Human-Training → TASK lane → claim", function () {
  async function deploy() {
    const [admin, alice, bob, l1, l2, checker, coordinator, treasury, funder] = await ethers.getSigners();

    EBASE = BigInt(await time.latest()) / EPOCH_LEN + 100n;

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");

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

    const stakeTok = await Mock.deploy("Stake", "STK");
    const Attest = await ethers.getContractFactory("AttestationStakeSlash");
    const attest = await Attest.deploy(await stakeTok.getAddress(), MIN_STAKE, admin.address, admin.address);

    const Gate = await ethers.getContractFactory("HumanContributionGate");
    const gate = await Gate.deploy(await attest.getAddress(), admin.address);
    await gate.grantRole(await gate.CHECKER_ROLE(), checker.address);

    const HReg = await ethers.getContractFactory("HumanTaskRegistry");
    const hreg = await HReg.deploy(admin.address);
    const Cred = await ethers.getContractFactory("ProofOfHumanCredential");
    const cred = await Cred.deploy(admin.address);
    const Rep = await ethers.getContractFactory("ReputationRegistry");
    const rep = await Rep.deploy(await prana.getAddress(), treasury.address, admin.address);

    const Creditor = await ethers.getContractFactory("HumanTaskCreditor");
    const creditor = await Creditor.deploy(
      await ledger.getAddress(),
      await hreg.getAddress(),
      await gate.getAddress(),
      await cred.getAddress(),
      await rep.getAddress(),
      admin.address
    );

    // orchestrator wiring
    await ledger.grantRole(await ledger.TASK_CREDITOR(), await creditor.getAddress());
    await gate.grantRole(await gate.CONSUMER_ROLE(), await creditor.getAddress());
    await creditor.grantRole(await creditor.CREDITOR_ROLE(), coordinator.address);
    await ledger.grantRole(await ledger.FUNDER_ROLE(), funder.address);

    // fund issuance budget
    await prana.mint(funder.address, 1_000_000n * ONE);
    await prana.connect(funder).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(funder).fundEpoch(100_000n * ONE);

    // governance: register human task (weight 1x = equal-to-hash, minReputation tier 1)
    await hreg.setTaskType(TASK_ID, SPEC, PREFERENCE_RANK, await gate.getAddress(), ONE, 1n, true, true);
    await rep.setTierThresholds([10n]);

    // labelers stake
    for (const a of [l1, l2]) {
      await stakeTok.mint(a.address, 10000n);
      await stakeTok.connect(a).approve(await attest.getAddress(), 10000n);
      await attest.connect(a).stake(MIN_STAKE);
    }

    // alice + bob are verified humans with tier-1 reputation
    for (const a of [alice, bob]) {
      await cred.verify(a.address, PROV);
      await rep.gain(a.address, 10n);
    }

    return {
      admin, alice, bob, l1, l2, checker, coordinator, funder,
      prana, ledger, gate, hreg, cred, rep, creditor
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

  async function verifyAndCredit(ctx, claimId, contributor, baseShares, taskId = TASK_ID) {
    await ctx.gate.openClaim(claimId, contributor.address, baseShares, 2, [ctx.l1.address, ctx.l2.address]);
    await ctx.gate.connect(ctx.l1).attest(claimId);
    await ctx.gate.connect(ctx.l2).attest(claimId);
    await ctx.gate.connect(ctx.checker).setGoldPassed(claimId, true);
    await ctx.gate.connect(ctx.checker).setAttentionPassed(claimId, true);
    await ctx.creditor.connect(ctx.coordinator).creditVerified(claimId, taskId);
  }

  it("full path: two humans contribute → credited to TASK lane → claim pro-rata PRANA", async () => {
    const ctx = await loadFixture(deploy);
    const { alice, bob, ledger, prana } = ctx;

    await gotoEpoch(10);
    const e = ep(10);
    // alice does 300 units of preference work, bob does 100.
    await verifyAndCredit(ctx, ethers.encodeBytes32String("c-alice"), alice, 300n);
    await verifyAndCredit(ctx, ethers.encodeBytes32String("c-bob"), bob, 100n);

    // both went into Lane.TASK; weight 1x -> pooled 300 + 100 = 400 this epoch.
    expect(await ledger.poolShares(e, alice.address)).to.equal(300n);
    expect(await ledger.poolShares(e, bob.address)).to.equal(100n);
    expect(await ledger.totalSharesAt(e)).to.equal(400n);

    // close epoch 10
    await gotoEpoch(11);

    const expAlice = (ISSUANCE * 300n) / 400n;
    const expBob = (ISSUANCE * 100n) / 400n;
    expect(await ledger.claimable(alice.address, e)).to.equal(expAlice);
    expect(await ledger.claimable(bob.address, e)).to.equal(expBob);

    await ledger.connect(alice).claim(e);
    await ledger.connect(bob).claim(e);
    expect(await prana.balanceOf(alice.address)).to.equal(expAlice);
    expect(await prana.balanceOf(bob.address)).to.equal(expBob);
  });

  it("human (TASK) work pools 1:1 with the lane default — equal-to-hash switching", async () => {
    const ctx = await loadFixture(deploy);
    const { alice, ledger } = ctx;
    await gotoEpoch(20);
    const e = ep(20);
    await verifyAndCredit(ctx, ethers.encodeBytes32String("c-a20"), alice, 100n);
    // weight 1x at registry AND lane -> exactly 100 pooled (no amplification/decay).
    expect(await ledger.poolShares(e, alice.address)).to.equal(100n);
  });
});
