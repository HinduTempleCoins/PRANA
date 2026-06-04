const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ERC20Base", function () {
  let t, admin, user, other;
  const CAP = 1000n;

  beforeEach(async () => {
    [admin, user, other] = await ethers.getSigners();
    const T = await ethers.getContractFactory("ERC20Base");
    t = await T.deploy("Base", "BASE", CAP, admin.address);
  });

  it("starts empty (no premine) with the configured cap", async () => {
    expect(await t.totalSupply()).to.equal(0n);
    expect(await t.cap()).to.equal(CAP);
  });

  it("mints up to the cap and rejects beyond it", async () => {
    await t.mint(user.address, 600n);
    await t.mint(user.address, 400n);
    expect(await t.totalSupply()).to.equal(1000n);
    await expect(t.mint(user.address, 1n)).to.be.reverted; // exceeds cap
  });

  it("only MINTER_ROLE can mint", async () => {
    await expect(t.connect(user).mint(user.address, 1n)).to.be.reverted;
  });

  it("pause blocks transfers; unpause restores them", async () => {
    await t.mint(user.address, 100n);
    await t.pause();
    await expect(t.connect(user).transfer(other.address, 1n)).to.be.reverted;
    await t.unpause();
    await t.connect(user).transfer(other.address, 10n);
    expect(await t.balanceOf(other.address)).to.equal(10n);
  });

  it("supports EIP-2612 permit (has a domain + nonces)", async () => {
    expect(await t.nonces(user.address)).to.equal(0n);
    expect(await t.DOMAIN_SEPARATOR()).to.not.equal(ethers.ZeroHash);
  });
});
