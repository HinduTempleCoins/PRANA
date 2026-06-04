const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PoLToken", function () {
  let pol, admin, minter, user;

  beforeEach(async () => {
    [admin, minter, user] = await ethers.getSigners();
    const PoL = await ethers.getContractFactory("PoLToken");
    pol = await PoL.deploy(admin.address);
  });

  it("has the expected name/symbol and zero initial supply (no premine)", async () => {
    expect(await pol.name()).to.equal("Proof of Liquidity");
    expect(await pol.symbol()).to.equal("POL");
    expect(await pol.totalSupply()).to.equal(0n);
  });

  it("admin (minter) can mint", async () => {
    await pol.mint(user.address, 1000n);
    expect(await pol.balanceOf(user.address)).to.equal(1000n);
    expect(await pol.totalSupply()).to.equal(1000n);
  });

  it("a non-minter cannot mint", async () => {
    await expect(pol.connect(user).mint(user.address, 1n)).to.be.reverted;
  });

  it("holders can burn their own tokens (supply sink)", async () => {
    await pol.mint(user.address, 1000n);
    await pol.connect(user).burn(400n);
    expect(await pol.balanceOf(user.address)).to.equal(600n);
    expect(await pol.totalSupply()).to.equal(600n);
  });

  it("MINTER_ROLE can be granted to an emission module", async () => {
    const MINTER = await pol.MINTER_ROLE();
    await pol.grantRole(MINTER, minter.address);
    await pol.connect(minter).mint(user.address, 5n);
    expect(await pol.balanceOf(user.address)).to.equal(5n);
  });
});
