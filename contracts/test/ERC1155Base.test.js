const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ERC1155Base", function () {
  const BASE_URI = "https://prana.example/api/token/{id}.json";
  let token, admin, minter, holder, other;

  beforeEach(async function () {
    [admin, minter, holder, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ERC1155Base");
    token = await Factory.deploy(BASE_URI, admin.address);
    await token.waitForDeployment();
  });

  it("lets a MINTER_ROLE holder mint and tracks balanceOf", async function () {
    await token.connect(admin).mint(holder.address, 1n, 100n, "0x");
    expect(await token.balanceOf(holder.address, 1n)).to.equal(100n);
  });

  it("reverts when a non-minter tries to mint", async function () {
    const MINTER_ROLE = await token.MINTER_ROLE();
    await expect(
      token.connect(other).mint(holder.address, 1n, 100n, "0x")
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), MINTER_ROLE);
  });

  it("supports batch mint and balanceOfBatch", async function () {
    const ids = [1n, 2n, 3n];
    const amounts = [10n, 20n, 30n];
    await token.connect(admin).mintBatch(holder.address, ids, amounts, "0x");

    const accounts = [holder.address, holder.address, holder.address];
    const balances = await token.balanceOfBatch(accounts, ids);
    expect(balances).to.deep.equal(amounts);
  });

  it("lets a holder burn their own tokens", async function () {
    await token.connect(admin).mint(holder.address, 1n, 100n, "0x");
    await token.connect(holder).burn(holder.address, 1n, 40n);
    expect(await token.balanceOf(holder.address, 1n)).to.equal(60n);
  });

  it("supportsInterface for ERC1155 and AccessControl", async function () {
    // ERC1155 = 0xd9b67a26, AccessControl (IAccessControl) = 0x7965db0b, ERC165 = 0x01ffc9a7
    expect(await token.supportsInterface("0xd9b67a26")).to.equal(true);
    expect(await token.supportsInterface("0x7965db0b")).to.equal(true);
    expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await token.supportsInterface("0xffffffff")).to.equal(false);
  });
});
