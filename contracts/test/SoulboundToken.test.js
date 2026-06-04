const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SoulboundToken", function () {
  let token, admin, minter, alice, bob;
  const URI = "ipfs://lore/fragment-1.json";

  beforeEach(async function () {
    [admin, minter, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SoulboundToken");
    token = await Factory.deploy("PRANA Lore", "LORE", admin.address);
    await token.waitForDeployment();

    const MINTER_ROLE = await token.MINTER_ROLE();
    await token.connect(admin).grantRole(MINTER_ROLE, minter.address);
  });

  it("mints a token to a recipient and records ownerOf / tokenURI", async function () {
    await token.connect(minter).mint(alice.address, URI);
    expect(await token.ownerOf(0)).to.equal(alice.address);
    expect(await token.tokenURI(0)).to.equal(URI);
    expect(await token.balanceOf(alice.address)).to.equal(1n);
  });

  it("reverts on transferFrom (soulbound)", async function () {
    await token.connect(minter).mint(alice.address, URI);
    await expect(
      token.connect(alice).transferFrom(alice.address, bob.address, 0)
    ).to.be.revertedWithCustomError(token, "Soulbound");
  });

  it("lets the holder burn their token", async function () {
    await token.connect(minter).mint(alice.address, URI);
    await token.connect(alice).burn(0);
    await expect(token.ownerOf(0)).to.be.reverted;
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("lets an admin burn any token", async function () {
    await token.connect(minter).mint(alice.address, URI);
    await token.connect(admin).burn(0);
    await expect(token.ownerOf(0)).to.be.reverted;
  });

  it("reverts when a non-minter tries to mint", async function () {
    await expect(
      token.connect(alice).mint(bob.address, URI)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });
});
