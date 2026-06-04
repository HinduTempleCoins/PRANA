const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SignedMintAuthorizer", function () {
  let token, authorizer, admin, signer, other, recipient;

  // Build the voucher digest exactly as the contract does:
  // keccak256(abi.encodePacked(to, amount, nonce)).
  function voucherDigest(to, amount, nonce) {
    return ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256"],
      [to, amount, nonce]
    );
  }

  // Sign the digest with the Ethereum Signed Message prefix (ethers signMessage over raw bytes
  // matches MessageHashUtils.toEthSignedMessageHash on-chain).
  function signVoucher(account, to, amount, nonce) {
    return account.signMessage(ethers.getBytes(voucherDigest(to, amount, nonce)));
  }

  beforeEach(async () => {
    [admin, signer, other, recipient] = await ethers.getSigners();

    const PoL = await ethers.getContractFactory("PoLToken");
    token = await PoL.deploy(admin.address);

    const Authorizer = await ethers.getContractFactory("SignedMintAuthorizer");
    authorizer = await Authorizer.deploy(await token.getAddress(), signer.address);

    // Grant the authorizer the right to mint.
    await token.grantRole(await token.MINTER_ROLE(), await authorizer.getAddress());
  });

  it("mints when given a valid signed voucher", async () => {
    const amount = 1000n;
    const nonce = 1n;
    const sig = await signVoucher(signer, recipient.address, amount, nonce);

    await expect(authorizer.claim(recipient.address, amount, nonce, sig))
      .to.emit(authorizer, "Claimed")
      .withArgs(recipient.address, amount, nonce);

    expect(await token.balanceOf(recipient.address)).to.equal(amount);
    expect(await authorizer.usedNonce(nonce)).to.equal(true);
  });

  it("reverts when the same nonce is reused", async () => {
    const amount = 500n;
    const nonce = 7n;
    const sig = await signVoucher(signer, recipient.address, amount, nonce);

    await authorizer.claim(recipient.address, amount, nonce, sig);
    await expect(
      authorizer.claim(recipient.address, amount, nonce, sig)
    ).to.be.revertedWith("nonce used");
  });

  it("reverts when the voucher is signed by a non-signer", async () => {
    const amount = 1000n;
    const nonce = 2n;
    const sig = await signVoucher(other, recipient.address, amount, nonce);

    await expect(
      authorizer.claim(recipient.address, amount, nonce, sig)
    ).to.be.revertedWith("bad signer");
  });

  it("reverts when the amount is tampered after signing", async () => {
    const nonce = 3n;
    const sig = await signVoucher(signer, recipient.address, 1000n, nonce);

    // Claim a different amount than what was signed -> recovered signer mismatches.
    await expect(
      authorizer.claim(recipient.address, 2000n, nonce, sig)
    ).to.be.revertedWith("bad signer");
  });

  it("mints to whoever is named in the voucher, regardless of caller", async () => {
    const amount = 42n;
    const nonce = 9n;
    const sig = await signVoucher(signer, recipient.address, amount, nonce);

    // `other` submits the tx, but tokens go to `recipient` (bound in the signature).
    await authorizer.connect(other).claim(recipient.address, amount, nonce, sig);
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
  });
});
