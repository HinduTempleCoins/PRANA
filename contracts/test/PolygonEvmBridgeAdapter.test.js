const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E18 = 10n ** 18n;
const UNPAUSE_DELAY = 3600;
const REMOTE_CHAIN = 137n; // Polygon mainnet chain id (config only)

// Mode enum mirror (UNSET, LOCK_RELEASE, BURN_MINT)
const Mode = { UNSET: 0, LOCK_RELEASE: 1, BURN_MINT: 2 };
const DEST = ethers.encodeBytes32String("dest");
const SRC = ethers.encodeBytes32String("src");

// Validators sign the EIP-191 prefix of the raw digest (matches verifySignatures).
function signDigest(signer, digest) {
  return signer.signMessage(ethers.getBytes(digest));
}

describe("PolygonEvmBridgeAdapter (BI4 — EVM↔EVM lock-mint adapter)", function () {
  async function deployFixture() {
    const [admin, v1, v2, v3, user, recipient, outsider] = await ethers.getSigners();

    // 2-of-3 federated validator set (real BI1 contract).
    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    const vset = await VSet.deploy(admin.address, [v1.address, v2.address, v3.address], 2);

    const Mock = await ethers.getContractFactory("MockERC20");
    const lockTok = await Mock.deploy("Lockable", "LOCK"); // LOCK_RELEASE
    const mintTok = await Mock.deploy("Mintable", "MINT"); // BURN_MINT

    const Adapter = await ethers.getContractFactory("PolygonEvmBridgeAdapter");
    const adapter = await Adapter.deploy(
      UNPAUSE_DELAY,
      admin.address,
      await vset.getAddress(),
      REMOTE_CHAIN
    );
    const adapterAddr = await adapter.getAddress();

    await adapter.connect(admin).setMode(await lockTok.getAddress(), Mode.LOCK_RELEASE);
    await adapter.connect(admin).setMode(await mintTok.getAddress(), Mode.BURN_MINT);

    await lockTok.mint(user.address, 1_000_000n * E18);
    await mintTok.mint(user.address, 1_000_000n * E18);
    await lockTok.connect(user).approve(adapterAddr, ethers.MaxUint256);
    await mintTok.connect(user).approve(adapterAddr, ethers.MaxUint256);

    // Pre-fund the adapter with lockTok so LOCK_RELEASE inbound has something to release.
    await lockTok.mint(adapterAddr, 1_000_000n * E18);

    return { adapter, adapterAddr, vset, lockTok, mintTok, admin, v1, v2, v3, user, recipient, outsider };
  }

  // Build the inbound digest as the contract does, then sign with K validators.
  async function attest(adapter, validators, { srcChainId, token, recipient, amount, mode, srcRef, nonce }) {
    const digest = await adapter.computeMessageHash(srcChainId, token, recipient, amount, mode, srcRef, nonce);
    const sigs = [];
    for (const v of validators) sigs.push(await signDigest(v, digest));
    return { digest, sigs };
  }

  it("deploys with roles, validator set, and remote chain wired", async () => {
    const { adapter, admin, vset } = await loadFixture(deployFixture);
    expect(await adapter.hasRole(await adapter.GUARDIAN_ROLE(), admin.address)).to.equal(true);
    expect(await adapter.validatorSet()).to.equal(await vset.getAddress());
    expect(await adapter.remoteChainId()).to.equal(REMOTE_CHAIN);
  });

  it("mode is immutable once set; only admin sets it", async () => {
    const { adapter, admin, outsider, lockTok } = await loadFixture(deployFixture);
    await expect(
      adapter.connect(admin).setMode(await lockTok.getAddress(), Mode.BURN_MINT)
    ).to.be.revertedWithCustomError(adapter, "ModeAlreadySet");

    const Mock = await ethers.getContractFactory("MockERC20");
    const fresh = await Mock.deploy("F", "F");
    await expect(
      adapter.connect(outsider).setMode(await fresh.getAddress(), Mode.LOCK_RELEASE)
    ).to.be.reverted;
    await expect(
      adapter.connect(admin).setMode(await fresh.getAddress(), Mode.UNSET)
    ).to.be.revertedWithCustomError(adapter, "WrongMode");
  });

  describe("outbound bridgeOut", function () {
    it("LOCK_RELEASE escrows tokens and emits MessageSent", async () => {
      const { adapter, adapterAddr, lockTok, user } = await loadFixture(deployFixture);
      const before = await lockTok.balanceOf(adapterAddr);
      await expect(adapter.connect(user).bridgeOut(await lockTok.getAddress(), 100n * E18, DEST))
        .to.emit(adapter, "MessageSent");
      expect(await lockTok.balanceOf(adapterAddr)).to.equal(before + 100n * E18);
      expect(await adapter.outboundNonce()).to.equal(1n);
    });

    it("BURN_MINT burns tokens (supply drops) and emits MessageSent", async () => {
      const { adapter, mintTok, user } = await loadFixture(deployFixture);
      const supplyBefore = await mintTok.totalSupply();
      await expect(adapter.connect(user).bridgeOut(await mintTok.getAddress(), 50n * E18, DEST))
        .to.emit(adapter, "MessageSent");
      expect(await mintTok.totalSupply()).to.equal(supplyBefore - 50n * E18);
    });

    it("reverts on unconfigured token and zero amount", async () => {
      const { adapter, lockTok, user } = await loadFixture(deployFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const fresh = await Mock.deploy("F", "F");
      await expect(
        adapter.connect(user).bridgeOut(await fresh.getAddress(), 1n, DEST)
      ).to.be.revertedWithCustomError(adapter, "TokenNotConfigured");
      await expect(
        adapter.connect(user).bridgeOut(await lockTok.getAddress(), 0n, DEST)
      ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
    });
  });

  describe("inbound bridgeIn (attested)", function () {
    it("LOCK_RELEASE releases to recipient on a K-of-N quorum", async () => {
      const { adapter, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      const msg = {
        srcChainId: REMOTE_CHAIN,
        token: await lockTok.getAddress(),
        recipient: recipient.address,
        amount: 200n * E18,
        mode: Mode.LOCK_RELEASE,
        srcRef: SRC,
        nonce: 1n,
      };
      const { sigs } = await attest(adapter, [v1, v2], msg);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.emit(adapter, "MessageConsumed");
      expect(await lockTok.balanceOf(recipient.address)).to.equal(200n * E18);
    });

    it("BURN_MINT mints to recipient on a K-of-N quorum", async () => {
      const { adapter, mintTok, recipient, v1, v3 } = await loadFixture(deployFixture);
      const msg = {
        srcChainId: REMOTE_CHAIN,
        token: await mintTok.getAddress(),
        recipient: recipient.address,
        amount: 77n * E18,
        mode: Mode.BURN_MINT,
        srcRef: SRC,
        nonce: 5n,
      };
      const { sigs } = await attest(adapter, [v1, v3], msg);
      await adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs);
      expect(await mintTok.balanceOf(recipient.address)).to.equal(77n * E18);
    });

    it("reverts below quorum (only K-1 signatures)", async () => {
      const { adapter, lockTok, recipient, v1 } = await loadFixture(deployFixture);
      const msg = {
        srcChainId: REMOTE_CHAIN, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 10n * E18, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce: 2n,
      };
      const { sigs } = await attest(adapter, [v1], msg);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "QuorumNotMet");
    });

    it("reverts on non-validator signatures", async () => {
      const { adapter, lockTok, recipient, outsider, user } = await loadFixture(deployFixture);
      const msg = {
        srcChainId: REMOTE_CHAIN, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 10n * E18, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce: 3n,
      };
      const { sigs } = await attest(adapter, [outsider, user], msg);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "QuorumNotMet");
    });

    it("replay protection: the same message cannot be consumed twice", async () => {
      const { adapter, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      const msg = {
        srcChainId: REMOTE_CHAIN, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 30n * E18, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce: 9n,
      };
      const { digest, sigs } = await attest(adapter, [v1, v2], msg);
      await adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs);
      expect(await adapter.consumedMessage(digest)).to.equal(true);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "MessageAlreadyConsumed");
    });

    it("rejects a message from the wrong source chain", async () => {
      const { adapter, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      const wrong = 1n;
      const msg = {
        srcChainId: wrong, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 5n * E18, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce: 11n,
      };
      const { sigs } = await attest(adapter, [v1, v2], msg);
      await expect(
        adapter.bridgeIn(wrong, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "WrongSourceChain");
    });

    it("rejects a mode mismatch vs the token's configured mode", async () => {
      const { adapter, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      // lockTok is LOCK_RELEASE; claim BURN_MINT.
      const msg = {
        srcChainId: REMOTE_CHAIN, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 5n * E18, mode: Mode.BURN_MINT, srcRef: SRC, nonce: 12n,
      };
      const { sigs } = await attest(adapter, [v1, v2], msg);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "WrongMode");
    });

    it("enforces the rolling daily cap", async () => {
      const { adapter, admin, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      await adapter.connect(admin).setDailyCap(await lockTok.getAddress(), 100n * E18);

      const tokenAddr = await lockTok.getAddress();
      const mk = (nonce, amount) => ({
        srcChainId: REMOTE_CHAIN, token: tokenAddr, recipient: recipient.address,
        amount, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce,
      });

      const m1 = { ...mk(20n, 80n * E18), token: tokenAddr };
      const a1 = await attest(adapter, [v1, v2], m1);
      await adapter.bridgeIn(m1.srcChainId, m1.token, m1.recipient, m1.amount, m1.mode, m1.srcRef, m1.nonce, a1.sigs);

      const m2 = { ...mk(21n, 30n * E18), token: tokenAddr };
      const a2 = await attest(adapter, [v1, v2], m2);
      await expect(
        adapter.bridgeIn(m2.srcChainId, m2.token, m2.recipient, m2.amount, m2.mode, m2.srcRef, m2.nonce, a2.sigs)
      ).to.be.revertedWithCustomError(adapter, "DailyCapExceeded");

      // After the window rolls, the cap resets.
      await time.increase(24 * 3600 + 1);
      const m3 = { ...mk(22n, 90n * E18), token: tokenAddr };
      const a3 = await attest(adapter, [v1, v2], m3);
      await adapter.bridgeIn(m3.srcChainId, m3.token, m3.recipient, m3.amount, m3.mode, m3.srcRef, m3.nonce, a3.sigs);
    });

    it("respects pause (guardian circuit-breaker)", async () => {
      const { adapter, admin, lockTok, recipient, v1, v2 } = await loadFixture(deployFixture);
      await adapter.connect(admin).pause();
      const msg = {
        srcChainId: REMOTE_CHAIN, token: await lockTok.getAddress(), recipient: recipient.address,
        amount: 5n * E18, mode: Mode.LOCK_RELEASE, srcRef: SRC, nonce: 31n,
      };
      const { sigs } = await attest(adapter, [v1, v2], msg);
      await expect(
        adapter.bridgeIn(msg.srcChainId, msg.token, msg.recipient, msg.amount, msg.mode, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(adapter, "EnforcedPause");
    });
  });
});
