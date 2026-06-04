const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AccessGate (burn-for-access)", function () {
  let token, gate, admin, user;
  const PRICE = 2n; // 2 tokens per second

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Access", "ACC");
    const AG = await ethers.getContractFactory("AccessGate");
    gate = await AG.deploy(await token.getAddress(), PRICE);
    await token.mint(user.address, 1000n);
    await token.connect(user).approve(await gate.getAddress(), 1000n);
  });

  it("quotes whole seconds (floor)", async () => {
    expect(await gate.quoteSeconds(10n)).to.equal(5n);
    expect(await gate.quoteSeconds(9n)).to.equal(4n);
  });

  it("burns only the whole-second cost and grants access", async () => {
    // 101 tokens at 2/sec -> 50 seconds, cost 100 (1 left unburned)
    await gate.connect(user).buy(101n);
    expect(await token.balanceOf(user.address)).to.equal(900n); // 1000 - 100
    expect(await token.totalSupply()).to.equal(900n);
    expect(await gate.hasAccess(user.address)).to.equal(true);
  });

  it("expires after the purchased duration", async () => {
    await gate.connect(user).buy(20n); // 10 seconds
    expect(await gate.hasAccess(user.address)).to.equal(true);
    await time.increase(11);
    expect(await gate.hasAccess(user.address)).to.equal(false);
  });

  it("stacks: buying while active extends from current expiry", async () => {
    await gate.connect(user).buy(20n); // +10s
    const firstExpiry = await gate.accessUntil(user.address);
    await gate.connect(user).buy(20n); // +10s more, from firstExpiry
    const secondExpiry = await gate.accessUntil(user.address);
    expect(secondExpiry - firstExpiry).to.equal(10n);
  });

  it("reverts when amount buys zero seconds", async () => {
    await expect(gate.connect(user).buy(1n)).to.be.revertedWith("too little");
  });
});
