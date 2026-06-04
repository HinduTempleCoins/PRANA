const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VoteEscrow", function () {
  let token, ve, admin, user;
  const MAX = 1000;

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Gov", "GOV");
    const VE = await ethers.getContractFactory("VoteEscrow");
    ve = await VE.deploy(await token.getAddress(), MAX);
    await token.mint(user.address, 1000n);
    await token.connect(user).approve(await ve.getAddress(), 1000n);
  });

  it("weight starts near full for a max-duration lock and decays to zero", async () => {
    await ve.connect(user).lock(1000n, MAX);
    const w0 = await ve.balanceOf(user.address);
    expect(w0 >= 995n && w0 <= 1000n).to.equal(true);

    await time.increase(500);
    const w1 = await ve.balanceOf(user.address);
    expect(w1 >= 495n && w1 <= 505n).to.equal(true);

    await time.increase(600); // past end
    expect(await ve.balanceOf(user.address)).to.equal(0n);
  });

  it("withdraw only after expiry, returns principal", async () => {
    await ve.connect(user).lock(1000n, MAX);
    await expect(ve.connect(user).withdraw()).to.be.revertedWith("still locked");
    await time.increase(MAX + 1);
    await ve.connect(user).withdraw();
    expect(await token.balanceOf(user.address)).to.equal(1000n);
  });

  it("increaseAmount raises weight", async () => {
    await ve.connect(user).lock(400n, MAX);
    await ve.connect(user).increaseAmount(400n);
    const w = await ve.balanceOf(user.address);
    expect(w >= 790n && w <= 800n).to.equal(true);
  });
});
