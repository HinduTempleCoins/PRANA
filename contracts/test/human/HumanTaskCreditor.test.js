const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const TASK = 1; // Lane.TASK
const PREFERENCE_RANK = 0;

const MIN_STAKE = 1000n;
const CLAIM = ethers.encodeBytes32String("hcredit-1");
const TASK_ID = ethers.id("rlhf-preference-v1");
const SPEC = ethers.id("spec-blob");
const PROV = ethers.id("captcha-of-record");
const BASE = 100n;

describe("HumanTaskCreditor (AG5)", function () {
  async function deploy() {
    const [admin, contributor, l1, l2, checker, coordinator, treasury] = await ethers.getSigners();

    // --- ledger stack ---
    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA");
    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    const cfg = await Cfg.deploy(admin.address, ONE, 1n, 1_000_000n);
    const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
    const ledger = await Ledger.deploy(await prana.getAddress(), await cfg.getAddress(), admin.address, 3600n, 2n, 1000n * ONE);

    // --- attestation + gate ---
    const stakeTok = await Mock.deploy("Stake", "STK");
    const Attest = await ethers.getContractFactory("AttestationStakeSlash");
    const attest = await Attest.deploy(await stakeTok.getAddress(), MIN_STAKE, admin.address, admin.address);
    const Gate = await ethers.getContractFactory("HumanContributionGate");
    const gate = await Gate.deploy(await attest.getAddress(), admin.address);
    await gate.grantRole(await gate.CHECKER_ROLE(), checker.address);

    // --- human registry / credential / reputation ---
    const HReg = await ethers.getContractFactory("HumanTaskRegistry");
    const hreg = await HReg.deploy(admin.address);
    const Cred = await ethers.getContractFactory("ProofOfHumanCredential");
    const cred = await Cred.deploy(admin.address);
    const Rep = await ethers.getContractFactory("ReputationRegistry");
    const rep = await Rep.deploy(await prana.getAddress(), treasury.address, admin.address);

    // --- creditor ---
    const Creditor = await ethers.getContractFactory("HumanTaskCreditor");
    const creditor = await Creditor.deploy(
      await ledger.getAddress(),
      await hreg.getAddress(),
      await gate.getAddress(),
      await cred.getAddress(),
      await rep.getAddress(),
      admin.address
    );

    // ---- the orchestrator role grants ----
    await ledger.grantRole(await ledger.TASK_CREDITOR(), await creditor.getAddress());
    await gate.grantRole(await gate.CONSUMER_ROLE(), await creditor.getAddress());
    await creditor.grantRole(await creditor.CREDITOR_ROLE(), coordinator.address);

    // register a task-type: weight 2x, minReputation tier 1
    await hreg.setTaskType(TASK_ID, SPEC, PREFERENCE_RANK, await gate.getAddress(), 2n * ONE, 1n, true, true);

    // tier thresholds: tier1 at score 10
    await rep.setTierThresholds([10n]);

    // stake labelers
    for (const a of [l1, l2]) {
      await stakeTok.mint(a.address, 10000n);
      await stakeTok.connect(a).approve(await attest.getAddress(), 10000n);
      await attest.connect(a).stake(MIN_STAKE);
    }

    // helper to fully verify a claim
    async function verifyClaim(claimId) {
      await gate.openClaim(claimId, contributor.address, BASE, 2, [l1.address, l2.address]);
      await gate.connect(l1).attest(claimId);
      await gate.connect(l2).attest(claimId);
      await gate.connect(checker).setGoldPassed(claimId, true);
      await gate.connect(checker).setAttentionPassed(claimId, true);
    }

    return {
      admin, contributor, l1, l2, checker, coordinator, treasury,
      prana, cfg, ledger, attest, gate, hreg, cred, rep, creditor, verifyClaim
    };
  }

  it("reverts on any zero dependency", async () => {
    const ctx = await loadFixture(deploy);
    const { ledger, hreg, gate, cred, rep, admin } = ctx;
    const C = await ethers.getContractFactory("HumanTaskCreditor");
    const L = await ledger.getAddress();
    const H = await hreg.getAddress();
    const G = await gate.getAddress();
    const P = await cred.getAddress();
    const R = await rep.getAddress();
    await expect(C.deploy(ethers.ZeroAddress, H, G, P, R, admin.address)).to.be.revertedWithCustomError(C, "ZeroLedger");
    await expect(C.deploy(L, ethers.ZeroAddress, G, P, R, admin.address)).to.be.revertedWithCustomError(C, "ZeroRegistry");
    await expect(C.deploy(L, H, ethers.ZeroAddress, P, R, admin.address)).to.be.revertedWithCustomError(C, "ZeroGate");
    await expect(C.deploy(L, H, G, ethers.ZeroAddress, R, admin.address)).to.be.revertedWithCustomError(C, "ZeroCredential");
    await expect(C.deploy(L, H, G, P, ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(C, "ZeroReputation");
  });

  it("credits weighted TASK-lane shares for a verified human contribution", async () => {
    const ctx = await loadFixture(deploy);
    const { contributor, coordinator, cred, rep, ledger, creditor, verifyClaim } = ctx;
    await cred.verify(contributor.address, PROV);
    await rep.gain(contributor.address, 10n); // tier 1
    await verifyClaim(CLAIM);

    const e = BigInt(await (await ethers.provider.getBlock("latest")).timestamp) / 3600n;
    // weight 2x: 100 base * 2 = 200 lane-native, ledger applies TASK lane weight 1x -> 200 pooled
    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID))
      .to.emit(creditor, "HumanContributionCredited")
      .withArgs(CLAIM, TASK_ID, contributor.address, BASE, 2n * ONE, 200n)
      .and.to.emit(ledger, "SharesCredited")
      .withArgs(e, TASK, contributor.address, 200n);

    expect(await ledger.poolShares(e, contributor.address)).to.equal(200n);
  });

  it("reverts if contributor is not a verified human", async () => {
    const ctx = await loadFixture(deploy);
    const { coordinator, rep, contributor, creditor, verifyClaim } = ctx;
    await rep.gain(contributor.address, 10n);
    await verifyClaim(CLAIM);
    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID)).to.be.revertedWithCustomError(
      creditor,
      "NotVerifiedHuman"
    );
  });

  it("reverts if reputation tier below the task's minimum", async () => {
    const ctx = await loadFixture(deploy);
    const { coordinator, cred, contributor, creditor, verifyClaim } = ctx;
    await cred.verify(contributor.address, PROV);
    // no rep gain -> tier 0 < required 1
    await verifyClaim(CLAIM);
    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID)).to.be.revertedWithCustomError(
      creditor,
      "InsufficientReputation"
    );
  });

  it("reverts if task disabled", async () => {
    const ctx = await loadFixture(deploy);
    const { coordinator, cred, rep, contributor, hreg, creditor, verifyClaim } = ctx;
    await cred.verify(contributor.address, PROV);
    await rep.gain(contributor.address, 10n);
    await hreg.setEnabled(TASK_ID, false);
    await verifyClaim(CLAIM);
    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID)).to.be.revertedWithCustomError(
      creditor,
      "TaskDisabled"
    );
  });

  it("consume is one-shot: a verdict can be credited only once", async () => {
    const ctx = await loadFixture(deploy);
    const { contributor, coordinator, cred, rep, creditor, gate, verifyClaim } = ctx;
    await cred.verify(contributor.address, PROV);
    await rep.gain(contributor.address, 10n);
    await verifyClaim(CLAIM);
    await creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID);
    await expect(creditor.connect(coordinator).creditVerified(CLAIM, TASK_ID)).to.be.revertedWithCustomError(
      gate,
      "AlreadyConsumed"
    );
  });

  it("only CREDITOR_ROLE may credit", async () => {
    const ctx = await loadFixture(deploy);
    const { contributor, cred, rep, creditor, verifyClaim } = ctx;
    await cred.verify(contributor.address, PROV);
    await rep.gain(contributor.address, 10n);
    await verifyClaim(CLAIM);
    await expect(creditor.connect(contributor).creditVerified(CLAIM, TASK_ID)).to.be.revertedWithCustomError(
      creditor,
      "AccessControlUnauthorizedAccount"
    );
  });
});
