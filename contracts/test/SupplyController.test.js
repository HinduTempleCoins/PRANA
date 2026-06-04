const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SupplyController", function () {
  let token, ctrl, admin, user, outsider;
  const CAP = 1000n;
  const EPOCH = 100;

  beforeEach(async () => {
    [admin, user, outsider] = await ethers.getSigners();
    const PoL = await ethers.getContractFactory("PoLToken");
    token = await PoL.deploy(admin.address);
    const SC = await ethers.getContractFactory("SupplyController");
    ctrl = await SC.deploy(await token.getAddress(), CAP, EPOCH, admin.address);
    await token.grantRole(await token.MINTER_ROLE(), await ctrl.getAddress());
  });

  it("mints up to the per-epoch cap and blocks beyond it", async () => {
    await ctrl.mintCapped(user.address, 600n);
    expect(await ctrl.remainingThisEpoch()).to.equal(400n);
    await ctrl.mintCapped(user.address, 400n);
    await expect(ctrl.mintCapped(user.address, 1n)).to.be.revertedWith("epoch cap");
    expect(await token.balanceOf(user.address)).to.equal(1000n);
  });

  it("resets the cap each epoch", async () => {
    await ctrl.mintCapped(user.address, 1000n);
    await time.increase(EPOCH + 1);
    await ctrl.mintCapped(user.address, 1000n); // new epoch, allowed again
    expect(await token.balanceOf(user.address)).to.equal(2000n);
  });

  it("only EMITTER_ROLE can mint", async () => {
    await expect(ctrl.connect(outsider).mintCapped(outsider.address, 1n)).to.be.reverted;
  });
});
