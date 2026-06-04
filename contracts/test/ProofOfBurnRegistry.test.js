const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProofOfBurnRegistry", function () {
  let token, reg, admin, user;

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Burn", "BRN");
    const R = await ethers.getContractFactory("ProofOfBurnRegistry");
    reg = await R.deploy();
    await token.mint(user.address, 1000n);
    await token.connect(user).approve(await reg.getAddress(), 1000n);
  });

  it("burns the token and records a receipt", async () => {
    const ref = ethers.encodeBytes32String("offer-1");
    await expect(reg.connect(user).recordBurn(await token.getAddress(), 250n, ref))
      .to.emit(reg, "Burned")
      .withArgs(0, user.address, await token.getAddress(), 250n, ref);

    expect(await token.totalSupply()).to.equal(750n);     // burned
    expect(await reg.count()).to.equal(1n);
    expect(await reg.totalBurnedBy(user.address)).to.equal(250n);
    expect(await reg.totalBurnedOf(await token.getAddress())).to.equal(250n);

    const r = await reg.receipts(0);
    expect(r.who).to.equal(user.address);
    expect(r.amount).to.equal(250n);
  });

  it("reverts on zero", async () => {
    await expect(
      reg.connect(user).recordBurn(await token.getAddress(), 0n, ethers.ZeroHash)
    ).to.be.revertedWith("amount=0");
  });
});
