const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SessionKeyGrant", function () {
  let g, account, key, target;
  const SELECTOR = "0x12345678";

  beforeEach(async () => {
    [account, key, target] = await ethers.getSigners();
    const G = await ethers.getContractFactory("SessionKeyGrant");
    g = await G.deploy();
  });

  it("authorizes within cap/selector/expiry and tracks spend", async () => {
    const expiry = (await time.latest()) + 10000;
    await g.connect(account).grant(key.address, target.address, SELECTOR, 1000n, expiry);

    expect(await g.check(account.address, key.address, target.address, SELECTOR, 600n)).to.equal(true);
    await g.consume(account.address, key.address, target.address, SELECTOR, 600n);
    expect(await g.remaining(account.address, key.address)).to.equal(400n);

    // exceeding the cap is rejected
    await expect(
      g.consume(account.address, key.address, target.address, SELECTOR, 500n)
    ).to.be.revertedWith("not authorized");
  });

  it("rejects the wrong selector", async () => {
    const expiry = (await time.latest()) + 10000;
    await g.connect(account).grant(key.address, target.address, SELECTOR, 1000n, expiry);
    expect(await g.check(account.address, key.address, target.address, "0xdeadbeef", 1n)).to.equal(false);
  });

  it("revoke disables the grant", async () => {
    const expiry = (await time.latest()) + 10000;
    await g.connect(account).grant(key.address, target.address, SELECTOR, 1000n, expiry);
    await g.connect(account).revoke(key.address);
    expect(await g.check(account.address, key.address, target.address, SELECTOR, 1n)).to.equal(false);
  });

  it("expiry disables the grant", async () => {
    const expiry = (await time.latest()) + 100;
    await g.connect(account).grant(key.address, target.address, SELECTOR, 1000n, expiry);
    await time.increase(101);
    expect(await g.check(account.address, key.address, target.address, SELECTOR, 1n)).to.equal(false);
  });
});
