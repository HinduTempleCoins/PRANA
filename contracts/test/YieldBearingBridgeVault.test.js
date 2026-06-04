const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E18 = 10n ** 18n;
const UNPAUSE_DELAY = 3600;
const REMOTE_CHAIN = 137n;
const DEST = ethers.encodeBytes32String("dest");
const SRC = ethers.encodeBytes32String("src");

function signDigest(signer, digest) {
  return signer.signMessage(ethers.getBytes(digest));
}

describe("YieldBearingBridgeVault (BI6 — gated by UD-BI-F: yield on bridged TVL)", function () {
  async function deployFixture() {
    const [admin, v1, v2, v3, user, recipient, beneficiary] = await ethers.getSigners();

    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    const vset = await VSet.deploy(admin.address, [v1.address, v2.address, v3.address], 2);

    const Mock = await ethers.getContractFactory("MockERC20");
    const asset = await Mock.deploy("Bridged USD", "bUSD");

    const Strat = await ethers.getContractFactory("MockYieldStrategy");
    const strategy = await Strat.deploy(await asset.getAddress());

    const Vault = await ethers.getContractFactory("YieldBearingBridgeVault");
    const vault = await Vault.deploy(
      UNPAUSE_DELAY,
      admin.address,
      await asset.getAddress(),
      await strategy.getAddress(),
      await vset.getAddress(),
      REMOTE_CHAIN
    );
    const vaultAddr = await vault.getAddress();

    await asset.mint(user.address, 1_000_000n * E18);
    await asset.connect(user).approve(vaultAddr, ethers.MaxUint256);
    await vault.connect(admin).setYieldBeneficiary(beneficiary.address);

    return { vault, vaultAddr, vset, asset, strategy, admin, v1, v2, v3, user, recipient, beneficiary };
  }

  async function attest(vault, validators, { srcChainId, recipient, amount, srcRef, nonce }) {
    const digest = await vault.computeMessageHash(srcChainId, recipient, amount, srcRef, nonce);
    const sigs = [];
    for (const v of validators) sigs.push(await signDigest(v, digest));
    return { digest, sigs };
  }

  it("reverts construction on strategy asset mismatch", async () => {
    const { admin, v1, v2, v3 } = await loadFixture(deployFixture);
    const Mock = await ethers.getContractFactory("MockERC20");
    const a = await Mock.deploy("A", "A");
    const b = await Mock.deploy("B", "B");
    const Strat = await ethers.getContractFactory("MockYieldStrategy");
    const stratForB = await Strat.deploy(await b.getAddress());
    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    const vset = await VSet.deploy(admin.address, [v1.address, v2.address, v3.address], 2);
    const Vault = await ethers.getContractFactory("YieldBearingBridgeVault");
    await expect(
      Vault.deploy(UNPAUSE_DELAY, admin.address, await a.getAddress(), await stratForB.getAddress(), await vset.getAddress(), REMOTE_CHAIN)
    ).to.be.revertedWithCustomError(Vault, "AssetMismatch");
  });

  it("bridgeOut locks principal into the strategy (TVL not idle)", async () => {
    const { vault, asset, strategy, user } = await loadFixture(deployFixture);
    await vault.connect(user).bridgeOut(100n * E18, DEST);
    expect(await vault.principal()).to.equal(100n * E18);
    // Principal sits in the strategy, not the vault.
    expect(await asset.balanceOf(await strategy.getAddress())).to.equal(100n * E18);
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("yield accrues to the beneficiary; principal stays 1:1 redeemable", async () => {
    const { vault, asset, strategy, user, recipient, beneficiary, v1, v2 } = await loadFixture(deployFixture);
    await vault.connect(user).bridgeOut(100n * E18, DEST);

    // Simulate yield: mint extra asset straight into the strategy.
    await asset.mint(await strategy.getAddress(), 20n * E18);
    expect(await vault.pendingYield()).to.equal(20n * E18);

    // Harvest sends ONLY the surplus to the beneficiary; principal untouched.
    await expect(vault.harvest())
      .to.emit(vault, "YieldHarvested")
      .withArgs(beneficiary.address, 20n * E18);
    expect(await asset.balanceOf(beneficiary.address)).to.equal(20n * E18);
    expect(await vault.principal()).to.equal(100n * E18);
    expect(await vault.pendingYield()).to.equal(0n);

    // Principal is still fully redeemable 1:1 via an attested inbound message.
    const msg = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 100n * E18, srcRef: SRC, nonce: 1n };
    const { sigs } = await attest(vault, [v1, v2], msg);
    await vault.bridgeIn(msg.srcChainId, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs);
    expect(await asset.balanceOf(recipient.address)).to.equal(100n * E18);
    expect(await vault.principal()).to.equal(0n);
  });

  it("harvest reverts when there is no yield / no beneficiary", async () => {
    const { vault, admin, asset, strategy, user } = await loadFixture(deployFixture);
    await vault.connect(user).bridgeOut(50n * E18, DEST);
    await expect(vault.harvest()).to.be.revertedWithCustomError(vault, "NoYield");

    // Fresh vault without a beneficiary set.
    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    const [, v1, v2, v3] = await ethers.getSigners();
    const vset = await VSet.deploy(admin.address, [v1.address, v2.address, v3.address], 2);
    const Strat = await ethers.getContractFactory("MockYieldStrategy");
    const strat2 = await Strat.deploy(await asset.getAddress());
    const Vault = await ethers.getContractFactory("YieldBearingBridgeVault");
    const v = await Vault.deploy(UNPAUSE_DELAY, admin.address, await asset.getAddress(), await strat2.getAddress(), await vset.getAddress(), REMOTE_CHAIN);
    await asset.mint(await strat2.getAddress(), 5n * E18);
    await expect(v.harvest()).to.be.revertedWithCustomError(v, "NoBeneficiary");
  });

  describe("inbound bridgeIn (attested release)", function () {
    it("releases principal to recipient on a K-of-N quorum", async () => {
      const { vault, asset, user, recipient, v1, v2 } = await loadFixture(deployFixture);
      await vault.connect(user).bridgeOut(40n * E18, DEST);
      const msg = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 40n * E18, srcRef: SRC, nonce: 7n };
      const { sigs } = await attest(vault, [v1, v2], msg);
      await expect(vault.bridgeIn(msg.srcChainId, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs))
        .to.emit(vault, "BridgeReleased");
      expect(await asset.balanceOf(recipient.address)).to.equal(40n * E18);
    });

    it("reverts below quorum", async () => {
      const { vault, user, recipient, v1 } = await loadFixture(deployFixture);
      await vault.connect(user).bridgeOut(40n * E18, DEST);
      const msg = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 40n * E18, srcRef: SRC, nonce: 8n };
      const { sigs } = await attest(vault, [v1], msg);
      await expect(
        vault.bridgeIn(msg.srcChainId, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(vault, "QuorumNotMet");
    });

    it("replay protection: same message cannot be consumed twice", async () => {
      const { vault, user, recipient, v1, v2 } = await loadFixture(deployFixture);
      await vault.connect(user).bridgeOut(80n * E18, DEST);
      const msg = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 40n * E18, srcRef: SRC, nonce: 9n };
      const { digest, sigs } = await attest(vault, [v1, v2], msg);
      await vault.bridgeIn(msg.srcChainId, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs);
      expect(await vault.consumedMessage(digest)).to.equal(true);
      await expect(
        vault.bridgeIn(msg.srcChainId, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(vault, "MessageAlreadyConsumed");
    });

    it("rejects wrong source chain", async () => {
      const { vault, user, recipient, v1, v2 } = await loadFixture(deployFixture);
      await vault.connect(user).bridgeOut(10n * E18, DEST);
      const msg = { srcChainId: 1n, recipient: recipient.address, amount: 10n * E18, srcRef: SRC, nonce: 10n };
      const { sigs } = await attest(vault, [v1, v2], msg);
      await expect(
        vault.bridgeIn(1n, msg.recipient, msg.amount, msg.srcRef, msg.nonce, sigs)
      ).to.be.revertedWithCustomError(vault, "WrongSourceChain");
    });

    it("enforces the rolling daily cap and resets after the window", async () => {
      const { vault, admin, user, recipient, v1, v2 } = await loadFixture(deployFixture);
      await vault.connect(user).bridgeOut(200n * E18, DEST);
      await vault.connect(admin).setDailyCap(100n * E18);

      const m1 = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 80n * E18, srcRef: SRC, nonce: 20n };
      const a1 = await attest(vault, [v1, v2], m1);
      await vault.bridgeIn(m1.srcChainId, m1.recipient, m1.amount, m1.srcRef, m1.nonce, a1.sigs);

      const m2 = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 30n * E18, srcRef: SRC, nonce: 21n };
      const a2 = await attest(vault, [v1, v2], m2);
      await expect(
        vault.bridgeIn(m2.srcChainId, m2.recipient, m2.amount, m2.srcRef, m2.nonce, a2.sigs)
      ).to.be.revertedWithCustomError(vault, "DailyCapExceeded");

      await time.increase(24 * 3600 + 1);
      const m3 = { srcChainId: REMOTE_CHAIN, recipient: recipient.address, amount: 90n * E18, srcRef: SRC, nonce: 22n };
      const a3 = await attest(vault, [v1, v2], m3);
      await vault.bridgeIn(m3.srcChainId, m3.recipient, m3.amount, m3.srcRef, m3.nonce, a3.sigs);
    });
  });
});
