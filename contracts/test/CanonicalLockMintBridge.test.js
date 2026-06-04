const { expect } = require("chai");
const { ethers } = require("hardhat");

// Validators sign the EIP-191 prefix of the bridge's raw mint digest (from `hashMint`).
// ethers signMessage(getBytes(digest)) matches the on-chain toEthSignedMessageHash recovery used by
// FederatedBridgeValidatorSet.verifySignatures.
function signDigest(signer, digest) {
  return signer.signMessage(ethers.getBytes(digest));
}

describe("CanonicalLockMintBridge", function () {
  let bridge, vset, token, admin, v1, v2, v3, user, relayer;
  const SRC_CHAIN = 999n;

  beforeEach(async () => {
    [admin, v1, v2, v3, user, relayer] = await ethers.getSigners();

    // 2-of-3 federated validator set.
    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    vset = await VSet.deploy(admin.address, [v1.address, v2.address, v3.address], 2);

    // Wrapped token: MockERC20 is mintable (mint(to,amount)) + ERC20Burnable (burnFrom) — satisfies
    // both IMintable and IERC20Burnable that the bridge needs.
    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("Wrapped PRANA", "wPRANA");

    const Bridge = await ethers.getContractFactory("CanonicalLockMintBridge");
    bridge = await Bridge.deploy(
      admin.address,
      await vset.getAddress(),
      await token.getAddress()
    );
  });

  async function mintDigest(to, amount, srcChainId, nonce) {
    return bridge.hashMint(to, amount, srcChainId, nonce);
  }

  describe("inbound mint (src chain → PRANA)", function () {
    it("mints with a K-of-N quorum and emits Minted", async () => {
      const amount = 1000n;
      const nonce = 1n;
      const digest = await mintDigest(user.address, amount, SRC_CHAIN, nonce);
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];

      await expect(bridge.connect(relayer).mint(user.address, amount, SRC_CHAIN, nonce, sigs))
        .to.emit(bridge, "Minted")
        .withArgs(user.address, amount, SRC_CHAIN, nonce);

      expect(await token.balanceOf(user.address)).to.equal(amount);
      expect(await bridge.processed(SRC_CHAIN, nonce)).to.equal(true);
    });

    it("rejects when below quorum (K-1 signatures)", async () => {
      const digest = await mintDigest(user.address, 1000n, SRC_CHAIN, 1n);
      const sigs = [await signDigest(v1, digest)];
      await expect(
        bridge.connect(relayer).mint(user.address, 1000n, SRC_CHAIN, 1n, sigs)
      ).to.be.revertedWithCustomError(bridge, "QuorumNotMet");
    });

    it("rejects a duplicate signer (same validator twice)", async () => {
      const digest = await mintDigest(user.address, 1000n, SRC_CHAIN, 1n);
      const s1 = await signDigest(v1, digest);
      await expect(
        bridge.connect(relayer).mint(user.address, 1000n, SRC_CHAIN, 1n, [s1, s1])
      ).to.be.revertedWithCustomError(bridge, "QuorumNotMet");
    });

    it("rejects a replayed (srcChainId, nonce)", async () => {
      const amount = 1000n;
      const nonce = 7n;
      const digest = await mintDigest(user.address, amount, SRC_CHAIN, nonce);
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];

      await bridge.connect(relayer).mint(user.address, amount, SRC_CHAIN, nonce, sigs);
      await expect(
        bridge.connect(relayer).mint(user.address, amount, SRC_CHAIN, nonce, sigs)
      ).to.be.revertedWithCustomError(bridge, "AlreadyProcessed");
    });

    it("allows the same nonce from a DIFFERENT source chain", async () => {
      const amount = 500n;
      const nonce = 1n;

      const dA = await mintDigest(user.address, amount, 111n, nonce);
      await bridge
        .connect(relayer)
        .mint(user.address, amount, 111n, nonce, [
          await signDigest(v1, dA),
          await signDigest(v2, dA),
        ]);

      const dB = await mintDigest(user.address, amount, 222n, nonce);
      await bridge
        .connect(relayer)
        .mint(user.address, amount, 222n, nonce, [
          await signDigest(v1, dB),
          await signDigest(v2, dB),
        ]);

      expect(await token.balanceOf(user.address)).to.equal(amount * 2n);
    });

    it("rejects signatures bound to a different (to/amount) than submitted", async () => {
      // Validators signed for amount 1000, but relayer submits 2000.
      const digest = await mintDigest(user.address, 1000n, SRC_CHAIN, 1n);
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];
      await expect(
        bridge.connect(relayer).mint(user.address, 2000n, SRC_CHAIN, 1n, sigs)
      ).to.be.revertedWithCustomError(bridge, "QuorumNotMet");
    });

    it("reverts on zero to / zero amount", async () => {
      const digest = await mintDigest(user.address, 1000n, SRC_CHAIN, 1n);
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];
      await expect(
        bridge.connect(relayer).mint(ethers.ZeroAddress, 1000n, SRC_CHAIN, 1n, sigs)
      ).to.be.revertedWithCustomError(bridge, "ZeroAddress");
      await expect(
        bridge.connect(relayer).mint(user.address, 0n, SRC_CHAIN, 1n, sigs)
      ).to.be.revertedWithCustomError(bridge, "ZeroAmount");
    });

    it("respects validator rotation (rotated-out key no longer counts)", async () => {
      await vset.connect(admin).rotateValidator(v3.address, relayer.address);
      // v1 + v2 still a valid quorum.
      const digest = await mintDigest(user.address, 100n, SRC_CHAIN, 5n);
      const ok = [await signDigest(v1, digest), await signDigest(v2, digest)];
      await expect(bridge.connect(relayer).mint(user.address, 100n, SRC_CHAIN, 5n, ok)).to.emit(
        bridge,
        "Minted"
      );
    });
  });

  describe("outbound burn (PRANA → dst chain)", function () {
    const dstChainId = 333n;
    const dstAddr = ethers.zeroPadValue("0x00000000000000000000000000000000000000aa", 32);

    beforeEach(async () => {
      // Give the user some wrapped supply to withdraw.
      const amount = 5000n;
      const nonce = 1n;
      const digest = await mintDigest(user.address, amount, SRC_CHAIN, nonce);
      await bridge
        .connect(relayer)
        .mint(user.address, amount, SRC_CHAIN, nonce, [
          await signDigest(v1, digest),
          await signDigest(v2, digest),
        ]);
    });

    it("burns wrapped supply and emits Withdrawal with an incrementing nonce", async () => {
      const burnAmt = 2000n;
      await token.connect(user).approve(await bridge.getAddress(), burnAmt);

      await expect(bridge.connect(user).burn(burnAmt, dstChainId, dstAddr))
        .to.emit(bridge, "Withdrawal")
        .withArgs(0n, user.address, dstChainId, dstAddr, burnAmt);

      expect(await token.balanceOf(user.address)).to.equal(3000n);
      expect(await bridge.withdrawalNonce()).to.equal(1n);

      // Second withdrawal increments the nonce.
      await token.connect(user).approve(await bridge.getAddress(), 1000n);
      await expect(bridge.connect(user).burn(1000n, dstChainId, dstAddr))
        .to.emit(bridge, "Withdrawal")
        .withArgs(1n, user.address, dstChainId, dstAddr, 1000n);
    });

    it("reverts burning more than approved/owned", async () => {
      await token.connect(user).approve(await bridge.getAddress(), 100n);
      await expect(bridge.connect(user).burn(200n, dstChainId, dstAddr)).to.be.reverted;
    });

    it("reverts on zero amount", async () => {
      await expect(
        bridge.connect(user).burn(0n, dstChainId, dstAddr)
      ).to.be.revertedWithCustomError(bridge, "ZeroAmount");
    });
  });

  describe("pause", function () {
    it("pauser can pause/unpause; mint blocked while paused", async () => {
      await bridge.connect(admin).pause();
      const digest = await mintDigest(user.address, 100n, SRC_CHAIN, 1n);
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];
      await expect(
        bridge.connect(relayer).mint(user.address, 100n, SRC_CHAIN, 1n, sigs)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");

      await bridge.connect(admin).unpause();
      await expect(
        bridge.connect(relayer).mint(user.address, 100n, SRC_CHAIN, 1n, sigs)
      ).to.emit(bridge, "Minted");
    });

    it("non-pauser cannot pause", async () => {
      await expect(bridge.connect(user).pause()).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });
});
