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
});
