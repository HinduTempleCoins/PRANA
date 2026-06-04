const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UtilityToken", function () {
  let token, admin, minter, spender, user, other;
  let MINTER_ROLE, SPENDER_ROLE;

  beforeEach(async function () {
    [admin, minter, spender, user, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("UtilityToken");
    token = await Factory.deploy("Catalyst", "C", admin.address);
    await token.waitForDeployment();

    MINTER_ROLE = await token.MINTER_ROLE();
    SPENDER_ROLE = await token.SPENDER_ROLE();

    await token.connect(admin).grantRole(MINTER_ROLE, minter.address);
    await token.connect(admin).grantRole(SPENDER_ROLE, spender.address);
  });

  it("lets a MINTER_ROLE account mint tokens", async function () {
    await token.connect(minter).mint(user.address, 1000n);
    expect(await token.balanceOf(user.address)).to.equal(1000n);
    expect(await token.totalSupply()).to.equal(1000n);
  });

  it("lets a holder burn their own tokens", async function () {
    await token.connect(minter).mint(user.address, 1000n);
    await token.connect(user).burn(400n);
    expect(await token.balanceOf(user.address)).to.equal(600n);
    expect(await token.totalSupply()).to.equal(600n);
  });

  it("reverts when a non-minter tries to mint", async function () {
    await expect(token.connect(other).mint(other.address, 1n))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, MINTER_ROLE);
  });

  it("lets a SPENDER_ROLE contract consume tokens the user approved", async function () {
    await token.connect(minter).mint(user.address, 1000n);
    await token.connect(user).approveSpender(spender.address, 300n);

    await expect(token.connect(spender).consume(user.address, 300n))
      .to.emit(token, "Consumed")
      .withArgs(spender.address, user.address, 300n);

    expect(await token.balanceOf(user.address)).to.equal(700n);
    expect(await token.totalSupply()).to.equal(700n);
    expect(await token.spenderAllowance(user.address, spender.address)).to.equal(0n);
  });

  it("reverts consume by a non-spender and when approval is insufficient", async function () {
    await token.connect(minter).mint(user.address, 1000n);

    // Caller lacks SPENDER_ROLE.
    await expect(token.connect(other).consume(user.address, 100n))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, SPENDER_ROLE);

    // Has the role, but user only approved 50.
    await token.connect(user).approveSpender(spender.address, 50n);
    await expect(token.connect(spender).consume(user.address, 100n))
      .to.be.revertedWith("UtilityToken: spend amount exceeds approval");
  });
});
