const { expect } = require("chai");
const { ethers } = require("hardhat");

// Validators sign the EIP-191 ("Ethereum Signed Message") prefix of the raw 32-byte digest.
// ethers `signMessage(getBytes(digest))` matches MessageHashUtils.toEthSignedMessageHash on-chain,
// which is exactly what FederatedBridgeValidatorSet.verifySignatures recovers against.
function signDigest(signer, digest) {
  return signer.signMessage(ethers.getBytes(digest));
}

describe("FederatedBridgeValidatorSet", function () {
  let vset, admin, v1, v2, v3, v4, outsider, newV;
  let digest;

  beforeEach(async () => {
    [admin, v1, v2, v3, v4, outsider, newV] = await ethers.getSigners();

    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    // 2-of-3 to start.
    vset = await VSet.deploy(
      admin.address,
      [v1.address, v2.address, v3.address],
      2
    );

    // An arbitrary message to sign across the suite.
    digest = ethers.solidityPackedKeccak256(["string", "uint256"], ["bridge-action", 42]);
  });

  it("reports the genesis set and threshold", async () => {
    expect(await vset.validatorCount()).to.equal(3n);
    expect(await vset.threshold()).to.equal(2n);
    expect(await vset.isValidator(v1.address)).to.equal(true);
    expect(await vset.isValidator(outsider.address)).to.equal(false);
  });

  it("rejects bad construction (empty set / bad threshold / dup validators)", async () => {
    const VSet = await ethers.getContractFactory("FederatedBridgeValidatorSet");
    await expect(VSet.deploy(admin.address, [], 1)).to.be.revertedWithCustomError(
      VSet,
      "EmptyValidatorSet"
    );
    await expect(
      VSet.deploy(admin.address, [v1.address, v2.address], 3)
    ).to.be.revertedWithCustomError(VSet, "InvalidThreshold");
    await expect(
      VSet.deploy(admin.address, [v1.address, v1.address], 1)
    ).to.be.revertedWithCustomError(VSet, "AlreadyValidator");
  });

  describe("K-of-N quorum (verifySignatures)", function () {
    it("accepts exactly K distinct validator signatures", async () => {
      const sigs = [await signDigest(v1, digest), await signDigest(v2, digest)];
      expect(await vset.verifySignatures(digest, sigs)).to.equal(true);
    });

    it("rejects K-1 signatures", async () => {
      const sigs = [await signDigest(v1, digest)];
      expect(await vset.verifySignatures(digest, sigs)).to.equal(false);
    });

    it("rejects duplicate signer (same validator twice does not reach quorum)", async () => {
      const s1 = await signDigest(v1, digest);
      // v1 signed twice → only 1 distinct validator → below threshold of 2.
      expect(await vset.verifySignatures(digest, [s1, s1])).to.equal(false);
    });

    it("ignores non-validator signatures", async () => {
      const sigs = [await signDigest(v1, digest), await signDigest(outsider, digest)];
      // only v1 is a real validator → 1 distinct → below threshold.
      expect(await vset.verifySignatures(digest, sigs)).to.equal(false);
    });

    it("accepts more than K signatures (extra valid sigs are fine)", async () => {
      const sigs = [
        await signDigest(v1, digest),
        await signDigest(v2, digest),
        await signDigest(v3, digest),
      ];
      expect(await vset.verifySignatures(digest, sigs)).to.equal(true);
    });

    it("ignores malformed signatures without reverting", async () => {
      const sigs = [
        await signDigest(v1, digest),
        await signDigest(v2, digest),
        "0x1234", // malformed → skipped
      ];
      expect(await vset.verifySignatures(digest, sigs)).to.equal(true);
    });
  });

  describe("governance", function () {
    it("admin can add a validator (N grows, K unchanged)", async () => {
      await expect(vset.connect(admin).addValidator(v4.address))
        .to.emit(vset, "ValidatorAdded")
        .withArgs(v4.address);
      expect(await vset.validatorCount()).to.equal(4n);
      expect(await vset.isValidator(v4.address)).to.equal(true);
    });

    it("non-admin cannot add a validator", async () => {
      await expect(
        vset.connect(outsider).addValidator(v4.address)
      ).to.be.revertedWithCustomError(vset, "AccessControlUnauthorizedAccount");
    });

    it("rejects adding an existing validator", async () => {
      await expect(
        vset.connect(admin).addValidator(v1.address)
      ).to.be.revertedWithCustomError(vset, "AlreadyValidator");
    });

    it("admin can remove a validator when quorum stays reachable", async () => {
      await vset.connect(admin).addValidator(v4.address); // N=4, K=2
      await expect(vset.connect(admin).removeValidator(v4.address))
        .to.emit(vset, "ValidatorRemoved")
        .withArgs(v4.address);
      expect(await vset.validatorCount()).to.equal(3n);
    });

    it("rejects a removal that would make quorum unreachable", async () => {
      // N=3, K=2; removing one → N=2 (still ok). Bump threshold to 3 first to force the revert.
      await vset.connect(admin).setThreshold(3);
      await expect(
        vset.connect(admin).removeValidator(v3.address)
      ).to.be.revertedWithCustomError(vset, "InvalidThreshold");
    });

    it("rotates a validator atomically (old out, new in)", async () => {
      await expect(vset.connect(admin).rotateValidator(v3.address, newV.address))
        .to.emit(vset, "ValidatorRotated")
        .withArgs(v3.address, newV.address);

      expect(await vset.isValidator(v3.address)).to.equal(false);
      expect(await vset.isValidator(newV.address)).to.equal(true);
      expect(await vset.validatorCount()).to.equal(3n);

      // After rotation, the rotated-out key's signature no longer counts; the new key's does.
      const sigsOld = [await signDigest(v1, digest), await signDigest(v3, digest)];
      expect(await vset.verifySignatures(digest, sigsOld)).to.equal(false);

      const sigsNew = [await signDigest(v1, digest), await signDigest(newV, digest)];
      expect(await vset.verifySignatures(digest, sigsNew)).to.equal(true);
    });

    it("rejects rotation onto an existing validator / off a non-validator", async () => {
      await expect(
        vset.connect(admin).rotateValidator(v1.address, v2.address)
      ).to.be.revertedWithCustomError(vset, "AlreadyValidator");
      await expect(
        vset.connect(admin).rotateValidator(outsider.address, newV.address)
      ).to.be.revertedWithCustomError(vset, "NotValidator");
    });

    it("admin can change the threshold within [1, N]", async () => {
      await expect(vset.connect(admin).setThreshold(3))
        .to.emit(vset, "ThresholdChanged")
        .withArgs(2n, 3n);
      expect(await vset.threshold()).to.equal(3n);

      // Now needs all 3.
      const two = [await signDigest(v1, digest), await signDigest(v2, digest)];
      expect(await vset.verifySignatures(digest, two)).to.equal(false);
      const three = [
        await signDigest(v1, digest),
        await signDigest(v2, digest),
        await signDigest(v3, digest),
      ];
      expect(await vset.verifySignatures(digest, three)).to.equal(true);
    });

    it("rejects out-of-range thresholds", async () => {
      await expect(vset.connect(admin).setThreshold(0)).to.be.revertedWithCustomError(
        vset,
        "InvalidThreshold"
      );
      await expect(vset.connect(admin).setThreshold(99)).to.be.revertedWithCustomError(
        vset,
        "InvalidThreshold"
      );
    });
  });
});
