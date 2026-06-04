const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SubscriptionLockNFT", function () {
  let pay, sub, admin, user, treasury;
  const PRICE = 100n;
  const PERIOD = 1000; // seconds

  beforeEach(async () => {
    [admin, user, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    pay = await Mock.deploy("Pay", "PAY");
    const Sub = await ethers.getContractFactory("SubscriptionLockNFT");
    sub = await Sub.deploy(await pay.getAddress(), PRICE, PERIOD, treasury.address);
    await pay.mint(user.address, 1000n);
    await pay.connect(user).approve(await sub.getAddress(), 1000n);
  });

  it("purchases a key, pays treasury, sets expiry", async () => {
    await sub.connect(user).purchase(user.address);
    expect(await sub.ownerOf(0)).to.equal(user.address);
    expect(await sub.isValid(0)).to.equal(true);
    expect(await pay.balanceOf(treasury.address)).to.equal(PRICE);
  });

  it("expires, then renew extends from now", async () => {
    await sub.connect(user).purchase(user.address);
    await time.increase(PERIOD + 1);
    expect(await sub.isValid(0)).to.equal(false);
    await sub.connect(user).renew(0);
    expect(await sub.isValid(0)).to.equal(true);
  });

  it("requires payment (approval)", async () => {
    await pay.connect(user).approve(await sub.getAddress(), 0n);
    await expect(sub.connect(user).purchase(user.address)).to.be.reverted;
  });
});
