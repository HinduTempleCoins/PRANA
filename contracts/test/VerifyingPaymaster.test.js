const { expect } = require("chai");
const { ethers } = require("hardhat");

// Build the eth-signed sponsorship signature the contract expects:
// digest = keccak256(abi.encodePacked(chainId, paymaster, user, maxCost, nonce)), personal_signed.
async function signSponsorship(signer, chainId, paymaster, user, maxCost, nonce) {
  const raw = ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "uint256", "uint256"],
    [chainId, paymaster, user, maxCost, nonce]
  );
  return signer.signMessage(ethers.getBytes(raw));
}

describe("VerifyingPaymaster", function () {
  let owner, verifyingSigner, stranger, user;
  let paymaster, token, chainId, pmAddr;
  const maxCost = ethers.parseEther("0.05");

  beforeEach(async function () {
    [owner, verifyingSigner, stranger, user] = await ethers.getSigners();

    const Paymaster = await ethers.getContractFactory("VerifyingPaymaster");
    paymaster = await Paymaster.deploy(owner.address, verifyingSigner.address);
    await paymaster.waitForDeployment();
    pmAddr = await paymaster.getAddress();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // Fund the deposit so sponsorships can be covered.
    await paymaster.connect(owner).deposit({ value: ethers.parseEther("1") });

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Mock USD", "mUSD");
    await token.waitForDeployment();
  });

  it("records a valid signed sponsorship and debits the deposit", async function () {
    const nonce = 1n;
    const sig = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, maxCost, nonce);

    await expect(paymaster.sponsor(user.address, maxCost, nonce, sig))
      .to.emit(paymaster, "Sponsored")
      .withArgs(user.address, maxCost, nonce);

    expect(await paymaster.sponsoredOf(user.address)).to.equal(maxCost);
    expect(await paymaster.totalSponsored()).to.equal(maxCost);
    expect(await paymaster.usedNonce(nonce)).to.equal(true);
  });

  it("reverts when a nonce is reused", async function () {
    const nonce = 7n;
    const sig = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, maxCost, nonce);

    await paymaster.sponsor(user.address, maxCost, nonce, sig);

    await expect(
      paymaster.sponsor(user.address, maxCost, nonce, sig)
    ).to.be.revertedWithCustomError(paymaster, "NonceAlreadyUsed");
  });

  it("reverts when signed by the wrong signer", async function () {
    const nonce = 2n;
    const badSig = await signSponsorship(stranger, chainId, pmAddr, user.address, maxCost, nonce);

    await expect(
      paymaster.sponsor(user.address, maxCost, nonce, badSig)
    ).to.be.revertedWithCustomError(paymaster, "InvalidSignature");

    expect(await paymaster.sponsoredOf(user.address)).to.equal(0n);
    expect(await paymaster.usedNonce(nonce)).to.equal(false);
  });

  it("SECURITY: rejects a signature for a different chainId (cross-chain replay)", async function () {
    const nonce = 11n;
    const otherChain = chainId + 1n;
    const sig = await signSponsorship(verifyingSigner, otherChain, pmAddr, user.address, maxCost, nonce);

    await expect(
      paymaster.sponsor(user.address, maxCost, nonce, sig)
    ).to.be.revertedWithCustomError(paymaster, "InvalidSignature");
  });

  it("SECURITY: rejects a signature bound to a different paymaster address", async function () {
    const nonce = 12n;
    const otherPaymaster = stranger.address; // any address that isn't this deployment
    const sig = await signSponsorship(verifyingSigner, chainId, otherPaymaster, user.address, maxCost, nonce);

    await expect(
      paymaster.sponsor(user.address, maxCost, nonce, sig)
    ).to.be.revertedWithCustomError(paymaster, "InvalidSignature");
  });

  it("SECURITY: one deposit cannot over-sponsor (cumulative debit caps at the balance)", async function () {
    // Deposit is 1 ETH. Sponsor 0.6 ETH twice: the second must exceed the reserved balance.
    const big = ethers.parseEther("0.6");
    const sig1 = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, big, 100n);
    const sig2 = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, big, 101n);

    await paymaster.sponsor(user.address, big, 100n, sig1);
    expect(await paymaster.totalSponsored()).to.equal(big);

    await expect(
      paymaster.sponsor(user.address, big, 101n, sig2)
    ).to.be.revertedWithCustomError(paymaster, "InsufficientDeposit");
  });

  it("owner cannot withdraw below the reserved (sponsored) balance", async function () {
    const sig = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, maxCost, 200n);
    await paymaster.sponsor(user.address, maxCost, 200n, sig);

    // Balance is 1 ETH, maxCost reserved; withdrawing the full 1 ETH must fail.
    await expect(
      paymaster.connect(owner).withdraw(owner.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(paymaster, "InsufficientDeposit");

    // Withdrawing up to (balance - reserved) succeeds.
    await paymaster.connect(owner).withdraw(owner.address, ethers.parseEther("1") - maxCost);
  });

  it("reverts when the deposit cannot cover maxCost", async function () {
    const nonce = 3n;
    const huge = ethers.parseEther("100");
    const sig = await signSponsorship(verifyingSigner, chainId, pmAddr, user.address, huge, nonce);

    await expect(
      paymaster.sponsor(user.address, huge, nonce, sig)
    ).to.be.revertedWithCustomError(paymaster, "InsufficientDeposit");
  });

  it("token mode pulls the stablecoin from the user to the owner", async function () {
    const amount = ethers.parseUnits("25", 18);
    await token.mint(user.address, amount);
    await token.connect(user).approve(await paymaster.getAddress(), amount);

    await expect(paymaster.connect(user).payInToken(await token.getAddress(), amount))
      .to.emit(paymaster, "PaidInToken")
      .withArgs(user.address, await token.getAddress(), amount);

    expect(await token.balanceOf(user.address)).to.equal(0n);
    expect(await token.balanceOf(owner.address)).to.equal(amount);
  });
});
