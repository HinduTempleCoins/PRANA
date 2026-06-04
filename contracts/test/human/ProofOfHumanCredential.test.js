const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const PROV = ethers.id("captcha-of-record");

describe("ProofOfHumanCredential (AG3)", function () {
  async function deploy() {
    const [admin, verifier, alice, outsider] = await ethers.getSigners();
    const Cred = await ethers.getContractFactory("ProofOfHumanCredential");
    const cred = await Cred.deploy(admin.address);
    await cred.grantRole(await cred.VERIFIER_ROLE(), verifier.address);
    return { cred, admin, verifier, alice, outsider };
  }

  it("reverts zero admin", async () => {
    const Cred = await ethers.getContractFactory("ProofOfHumanCredential");
    await expect(Cred.deploy(ethers.ZeroAddress)).to.be.revertedWith("admin=0");
  });

  it("verifier attests humanity with a provenance tag", async () => {
    const { cred, verifier, alice } = await loadFixture(deploy);
    expect(await cred.isVerifiedHuman(alice.address)).to.equal(false);
    await expect(cred.connect(verifier).verify(alice.address, PROV))
      .to.emit(cred, "HumanVerified")
      .withArgs(alice.address, PROV, verifier.address);
    expect(await cred.isVerifiedHuman(alice.address)).to.equal(true);
    expect(await cred.provenanceOf(alice.address)).to.equal(PROV);
  });

  it("only VERIFIER may verify / revoke; zero inputs revert", async () => {
    const { cred, verifier, alice, outsider } = await loadFixture(deploy);
    await expect(cred.connect(outsider).verify(alice.address, PROV)).to.be.revertedWithCustomError(
      cred,
      "AccessControlUnauthorizedAccount"
    );
    await expect(cred.connect(verifier).verify(ethers.ZeroAddress, PROV)).to.be.revertedWithCustomError(
      cred,
      "ZeroSubject"
    );
    await expect(cred.connect(verifier).verify(alice.address, ethers.ZeroHash)).to.be.revertedWithCustomError(
      cred,
      "ZeroProvenance"
    );
  });

  it("revoke clears the credential and reverts if not verified", async () => {
    const { cred, verifier, alice } = await loadFixture(deploy);
    await expect(cred.connect(verifier).revoke(alice.address)).to.be.revertedWithCustomError(cred, "NotVerified");
    await cred.connect(verifier).verify(alice.address, PROV);
    await expect(cred.connect(verifier).revoke(alice.address))
      .to.emit(cred, "HumanRevoked")
      .withArgs(alice.address, verifier.address);
    expect(await cred.isVerifiedHuman(alice.address)).to.equal(false);
    expect(await cred.provenanceOf(alice.address)).to.equal(ethers.ZeroHash);
  });
});
