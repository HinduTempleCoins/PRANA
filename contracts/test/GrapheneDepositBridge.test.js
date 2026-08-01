const { expect } = require("chai");
const { ethers } = require("hardhat");

const MELEK_ID = ethers.id("MELEK@origin");
const VKBT_ID = ethers.id("VKBT@origin");
const UNREG_ID = ethers.id("UNREGISTERED");
const ZERO = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;

// Custodian role hash on WrappedEcosystemToken.
const CUSTODIAN_ROLE = ethers.id("CUSTODIAN_ROLE");

async function deployWrapped(admin, custodian, name, symbol, originRef) {
  const W = await ethers.getContractFactory("WrappedEcosystemToken");
  return W.deploy(name, symbol, 18, originRef, admin.address, custodian.address);
}

describe("GrapheneDepositBridge", function () {
  let bridge, wMelek;
  let admin, a1, a2, a3, user, outsider;

  beforeEach(async () => {
    [admin, a1, a2, a3, user, outsider] = await ethers.getSigners();

    // Built-in attester mode: no external validator set.
    const B = await ethers.getContractFactory("GrapheneDepositBridge");
    bridge = await B.deploy(admin.address, ZERO);

    // wMELEK wrapper whose custodian is the bridge so the bridge can mint on deposit.
    wMelek = await deployWrapped(admin, admin, "Wrapped MELEK", "wMELEK", MELEK_ID);
    await wMelek.connect(admin).grantRole(CUSTODIAN_ROLE, await bridge.getAddress());

    // Register the token + grant 3 attesters, K=2.
    await bridge.connect(admin).registerToken(MELEK_ID, await wMelek.getAddress());
    const ATTESTER = await bridge.ATTESTER_ROLE();
    await bridge.connect(admin).grantRole(ATTESTER, a1.address);
    await bridge.connect(admin).grantRole(ATTESTER, a2.address);
    await bridge.connect(admin).grantRole(ATTESTER, a3.address);
    await bridge.connect(admin).setLocalQuorum(2);
  });

  it("registers a token and exposes it via wrappedToken", async () => {
    expect(await bridge.wrappedToken(MELEK_ID)).to.equal(await wMelek.getAddress());
  });

  it("rejects a duplicate token registration", async () => {
    await expect(
      bridge.connect(admin).registerToken(MELEK_ID, await wMelek.getAddress())
    ).to.be.revertedWithCustomError(bridge, "TokenAlreadyRegistered");
  });

  it("only admin can register / set quorum", async () => {
    await expect(
      bridge.connect(outsider).registerToken(VKBT_ID, await wMelek.getAddress())
    ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
    await expect(
      bridge.connect(outsider).setLocalQuorum(1)
    ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
  });

  it("K-of-N attested deposit mints the right wrapped amount to recipient", async () => {
    const ref = ethers.id("melek-tx-1");
    const amount = 1000n;

    // First attestation: counted, not yet minted.
    await expect(bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, amount))
      .to.emit(bridge, "DepositAttested")
      .withArgs(ref, MELEK_ID, a1.address, user.address, amount, 1n, 2n);
    expect(await wMelek.balanceOf(user.address)).to.equal(0n);

    // Second distinct attestation crosses K=2 → mints.
    await expect(bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, amount))
      .to.emit(bridge, "DepositMinted")
      .withArgs(ref, MELEK_ID, user.address, await wMelek.getAddress(), amount)
      .and.to.emit(wMelek, "WrappedMinted")
      .withArgs(user.address, amount, ref);

    expect(await wMelek.balanceOf(user.address)).to.equal(amount);
    expect(await bridge.depositProcessed(ref)).to.equal(true);
  });

  it("replayed deposit ref reverts after mint", async () => {
    const ref = ethers.id("melek-tx-2");
    await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 500n);
    await bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 500n);

    // Any further attestation on the consumed ref reverts.
    await expect(
      bridge.connect(a3).attestDeposit(ref, MELEK_ID, user.address, 500n)
    ).to.be.revertedWithCustomError(bridge, "DepositAlreadyProcessed");
  });

  it("unregistered token reverts", async () => {
    const ref = ethers.id("melek-tx-3");
    await expect(
      bridge.connect(a1).attestDeposit(ref, UNREG_ID, user.address, 1n)
    ).to.be.revertedWithCustomError(bridge, "TokenNotRegistered");
  });

  it("non-attester cannot attest", async () => {
    const ref = ethers.id("melek-tx-4");
    await expect(
      bridge.connect(outsider).attestDeposit(ref, MELEK_ID, user.address, 1n)
    ).to.be.revertedWithCustomError(bridge, "NotAnAttester");
  });

  it("same attester cannot double-attest one ref", async () => {
    const ref = ethers.id("melek-tx-5");
    await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 1n);
    await expect(
      bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 1n)
    ).to.be.revertedWithCustomError(bridge, "AlreadyAttested");
  });

  it("attesters disagreeing on the tuple revert (no cross-tally)", async () => {
    const ref = ethers.id("melek-tx-6");
    await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 1000n);
    await expect(
      bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 999n)
    ).to.be.revertedWithCustomError(bridge, "AttestationMismatch");
  });

  it("rejects zero ref / zero recipient / zero amount", async () => {
    await expect(
      bridge.connect(a1).attestDeposit(ZERO_HASH, MELEK_ID, user.address, 1n)
    ).to.be.revertedWithCustomError(bridge, "ZeroRef");
    await expect(
      bridge.connect(a1).attestDeposit(ethers.id("r"), MELEK_ID, ZERO, 1n)
    ).to.be.revertedWithCustomError(bridge, "ZeroAddress");
    await expect(
      bridge.connect(a1).attestDeposit(ethers.id("r"), MELEK_ID, user.address, 0n)
    ).to.be.revertedWithCustomError(bridge, "ZeroAmount");
  });

  it("reverts attestation when no quorum is configured", async () => {
    // Fresh bridge with a token but quorum never set.
    const B = await ethers.getContractFactory("GrapheneDepositBridge");
    const b2 = await B.deploy(admin.address, ZERO);
    const w = await deployWrapped(admin, admin, "Wrapped VKBT", "wVKBT", VKBT_ID);
    await w.connect(admin).grantRole(CUSTODIAN_ROLE, await b2.getAddress());
    await b2.connect(admin).registerToken(VKBT_ID, await w.getAddress());
    const ATTESTER = await b2.ATTESTER_ROLE();
    await b2.connect(admin).grantRole(ATTESTER, a1.address);

    await expect(
      b2.connect(a1).attestDeposit(ethers.id("r"), VKBT_ID, user.address, 1n)
    ).to.be.revertedWithCustomError(b2, "NoQuorumConfigured");
  });

  it("withdraw burns wrapped supply and emits GrapheneWithdrawal", async () => {
    // Mint user some wMELEK via a completed deposit.
    const ref = ethers.id("melek-tx-7");
    await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 1000n);
    await bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 1000n);
    expect(await wMelek.balanceOf(user.address)).to.equal(1000n);

    const dest = ethers.id("melek-account-bob");
    await wMelek.connect(user).approve(await bridge.getAddress(), 400n);

    await expect(bridge.connect(user).withdraw(MELEK_ID, 400n, dest))
      .to.emit(bridge, "GrapheneWithdrawal")
      .withArgs(0n, MELEK_ID, user.address, await wMelek.getAddress(), 400n, dest);

    expect(await wMelek.balanceOf(user.address)).to.equal(600n);
    expect(await wMelek.totalSupply()).to.equal(600n); // burned, not escrowed
  });

  it("withdraw reverts on unregistered token / zero amount", async () => {
    await expect(
      bridge.connect(user).withdraw(UNREG_ID, 1n, ZERO_HASH)
    ).to.be.revertedWithCustomError(bridge, "TokenNotRegistered");
    await expect(
      bridge.connect(user).withdraw(MELEK_ID, 0n, ZERO_HASH)
    ).to.be.revertedWithCustomError(bridge, "ZeroAmount");
  });

  describe("external validator-set mode", function () {
    let vset;

    beforeEach(async () => {
      // Minimal mock IBridgeValidatorSet: a1 & a2 are validators, quorum = 2.
      const Mock = await ethers.getContractFactory("MockBridgeValidatorSet");
      vset = await Mock.deploy(2);
      await vset.setValidator(a1.address, true);
      await vset.setValidator(a2.address, true);
      await bridge.connect(admin).setValidatorSet(await vset.getAddress());
    });

    it("uses the external set for membership + quorum", async () => {
      expect(await bridge.isAttester(a1.address)).to.equal(true);
      expect(await bridge.isAttester(a3.address)).to.equal(false); // role-only, not in ext set
      expect(await bridge.requiredQuorum()).to.equal(2n);

      const ref = ethers.id("ext-1");
      await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 250n);
      await expect(bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 250n))
        .to.emit(bridge, "DepositMinted")
        .withArgs(ref, MELEK_ID, user.address, await wMelek.getAddress(), 250n);
      expect(await wMelek.balanceOf(user.address)).to.equal(250n);
    });

    it("a role-only attester is rejected once an external set is wired", async () => {
      await expect(
        bridge.connect(a3).attestDeposit(ethers.id("ext-2"), MELEK_ID, user.address, 1n)
      ).to.be.revertedWithCustomError(bridge, "NotAnAttester");
    });
  });

  // Audit M1: the FIRST attestation locks a ref's tuple, so one bad first attester can brick a
  // real deposit forever. resetDeposit clears a NOT-YET-MINTED tally so honest attesters can
  // re-form quorum on the true tuple — without ever letting a minted ref be replayed.
  describe("resetDeposit (poisoned-deposit escape hatch)", function () {
    it("lets honest attesters re-form quorum on the true tuple after a poisoned first attestation", async () => {
      const ref = ethers.id("poisoned-1");

      // a3 poisons the ref with the wrong recipient/amount.
      await bridge.connect(a3).attestDeposit(ref, MELEK_ID, outsider.address, 999n);
      // Honest attesters reporting the TRUE tuple are locked out.
      await expect(
        bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 100n)
      ).to.be.revertedWithCustomError(bridge, "AttestationMismatch");

      await expect(bridge.connect(admin).resetDeposit(ref))
        .to.emit(bridge, "DepositReset")
        .withArgs(ref);

      // Now the true tuple reaches quorum and mints.
      await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 100n);
      await expect(bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 100n))
        .to.emit(bridge, "DepositMinted")
        .withArgs(ref, MELEK_ID, user.address, await wMelek.getAddress(), 100n);
      expect(await wMelek.balanceOf(user.address)).to.equal(100n);
    });

    it("cannot reset a minted ref (no replay) and rejects a zero ref", async () => {
      const ref = ethers.id("minted-1");
      await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, 10n);
      await bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, 10n);

      await expect(
        bridge.connect(admin).resetDeposit(ref)
      ).to.be.revertedWithCustomError(bridge, "DepositAlreadyProcessed");
      await expect(
        bridge.connect(admin).resetDeposit(ZERO_HASH)
      ).to.be.revertedWithCustomError(bridge, "ZeroRef");
      expect(await wMelek.balanceOf(user.address)).to.equal(10n);
    });

    it("only admin can reset", async () => {
      await expect(
        bridge.connect(outsider).resetDeposit(ethers.id("x"))
      ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
    });
  });

  // Audit M2: an emergency stop for a suspected attester compromise. Halts mint + burn; admin
  // registry ops and views stay live so the federation can be rotated while paused.
  describe("pause (emergency stop)", function () {
    it("halts attestation and resumes cleanly", async () => {
      await bridge.connect(admin).pause();
      await expect(
        bridge.connect(a1).attestDeposit(ethers.id("p-1"), MELEK_ID, user.address, 5n)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");

      await bridge.connect(admin).unpause();
      await bridge.connect(a1).attestDeposit(ethers.id("p-1"), MELEK_ID, user.address, 5n);
      await bridge.connect(a2).attestDeposit(ethers.id("p-1"), MELEK_ID, user.address, 5n);
      expect(await wMelek.balanceOf(user.address)).to.equal(5n);
    });

    it("halts withdrawals while paused", async () => {
      await bridge.connect(a1).attestDeposit(ethers.id("p-2"), MELEK_ID, user.address, 50n);
      await bridge.connect(a2).attestDeposit(ethers.id("p-2"), MELEK_ID, user.address, 50n);

      await bridge.connect(admin).pause();
      await expect(
        bridge.connect(user).withdraw(MELEK_ID, 10n, ethers.id("hathor"))
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("leaves admin registry ops usable while paused (rotate the federation under stop)", async () => {
      await bridge.connect(admin).pause();
      const ATTESTER = await bridge.ATTESTER_ROLE();
      await bridge.connect(admin).revokeRole(ATTESTER, a3.address);
      expect(await bridge.isAttester(a3.address)).to.equal(false);
      await bridge.connect(admin).setLocalQuorum(3);
      expect(await bridge.requiredQuorum()).to.equal(3n);
    });

    it("only PAUSER_ROLE can pause / unpause", async () => {
      await expect(
        bridge.connect(outsider).pause()
      ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
      await bridge.connect(admin).pause();
      await expect(
        bridge.connect(outsider).unpause()
      ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
    });
  });

  // Audit hardening: a per-token rolling-24h mint cap bounds the blast radius of an attester
  // compromise. Opt-in (0 = uncapped), and a breach DEFERS the mint instead of reverting so the
  // K-th attestation is never rolled back and the deposit can never be stranded.
  describe("daily mint cap", function () {
    const DAY = 24 * 60 * 60;

    async function reachQuorum(ref, amount) {
      await bridge.connect(a1).attestDeposit(ref, MELEK_ID, user.address, amount);
      return bridge.connect(a2).attestDeposit(ref, MELEK_ID, user.address, amount);
    }

    it("is uncapped by default", async () => {
      expect(await bridge.dailyMintCap(MELEK_ID)).to.equal(0n);
      await reachQuorum(ethers.id("cap-uncapped"), 10n ** 30n);
      expect(await wMelek.balanceOf(user.address)).to.equal(10n ** 30n);
    });

    it("only admin can set the cap", async () => {
      await expect(
        bridge.connect(outsider).setDailyMintCap(MELEK_ID, 100n)
      ).to.be.revertedWithCustomError(bridge, "AccessControlUnauthorizedAccount");
      await expect(bridge.connect(admin).setDailyMintCap(MELEK_ID, 100n))
        .to.emit(bridge, "DailyMintCapUpdated")
        .withArgs(MELEK_ID, 100n);
      expect(await bridge.dailyMintCap(MELEK_ID)).to.equal(100n);
    });

    it("mints while under the cap and defers the mint that would breach it", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 100n);

      await reachQuorum(ethers.id("cap-a"), 60n);
      expect(await wMelek.balanceOf(user.address)).to.equal(60n);

      // 60 + 50 > 100 → deferred, NOT reverted, and NOT minted.
      await expect(reachQuorum(ethers.id("cap-b"), 50n))
        .to.emit(bridge, "DepositDeferredByCap")
        .withArgs(ethers.id("cap-b"), MELEK_ID, 50n, 100n);
      expect(await wMelek.balanceOf(user.address)).to.equal(60n);
      expect(await bridge.depositProcessed(ethers.id("cap-b"))).to.equal(false);
    });

    it("keeps the deferred deposit's quorum on record (the K-th vote is not rolled back)", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 10n);
      await reachQuorum(ethers.id("cap-c"), 999n);
      const d = await bridge.depositStatus(ethers.id("cap-c"));
      expect(d.count).to.equal(2n);
      expect(d.minted).to.equal(false);
    });

    it("finalizeDeposit reverts while the window still has no headroom", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 100n);
      await reachQuorum(ethers.id("cap-d1"), 100n); // fills the window
      await reachQuorum(ethers.id("cap-d2"), 5n); // deferred
      await expect(
        bridge.connect(outsider).finalizeDeposit(ethers.id("cap-d2"))
      ).to.be.revertedWithCustomError(bridge, "DailyMintCapExceeded");
    });

    it("finalizeDeposit mints the deferred deposit once the 24h window rolls", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 100n);
      await reachQuorum(ethers.id("cap-e1"), 100n);
      await reachQuorum(ethers.id("cap-e2"), 40n); // deferred

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      // Permissionless: anyone may finalize the already-agreed tuple.
      await expect(bridge.connect(outsider).finalizeDeposit(ethers.id("cap-e2")))
        .to.emit(bridge, "DepositMinted")
        .withArgs(ethers.id("cap-e2"), MELEK_ID, user.address, await wMelek.getAddress(), 40n);
      expect(await wMelek.balanceOf(user.address)).to.equal(140n);
      expect(await bridge.depositProcessed(ethers.id("cap-e2"))).to.equal(true);
    });

    it("finalizeDeposit cannot double-mint or run without quorum", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 1000n);
      const ref = ethers.id("cap-f");
      await reachQuorum(ref, 10n); // minted inline
      await expect(
        bridge.connect(outsider).finalizeDeposit(ref)
      ).to.be.revertedWithCustomError(bridge, "DepositAlreadyProcessed");

      const lonely = ethers.id("cap-g");
      await bridge.connect(a1).attestDeposit(lonely, MELEK_ID, user.address, 10n); // 1 of 2
      await expect(
        bridge.connect(outsider).finalizeDeposit(lonely)
      ).to.be.revertedWithCustomError(bridge, "QuorumNotReached");
    });

    it("a breached cap does not consume window headroom (failed check writes nothing)", async () => {
      await bridge.connect(admin).setDailyMintCap(MELEK_ID, 100n);
      await reachQuorum(ethers.id("cap-h1"), 90n);
      await reachQuorum(ethers.id("cap-h2"), 50n); // deferred, must not eat the remaining 10
      await reachQuorum(ethers.id("cap-h3"), 10n); // still fits → mints
      expect(await wMelek.balanceOf(user.address)).to.equal(100n);
    });
  });
});
