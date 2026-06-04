const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RevenueSplitter", function () {
  let token, splitter, admin, alice, bob;

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Rev", "REV");
    const S = await ethers.getContractFactory("RevenueSplitter");
    splitter = await S.deploy([alice.address, bob.address], [60, 40]); // 60/40
  });

  it("splits ERC-20 revenue by share and pays out on pull", async () => {
    await token.mint(await splitter.getAddress(), 1000n);
    expect(await splitter.releasableERC20(await token.getAddress(), alice.address)).to.equal(600n);
    expect(await splitter.releasableERC20(await token.getAddress(), bob.address)).to.equal(400n);

    await splitter.releaseERC20(await token.getAddress(), alice.address);
    expect(await token.balanceOf(alice.address)).to.equal(600n);
    // a second deposit accrues more for the same payee
    await token.mint(await splitter.getAddress(), 500n);
    expect(await splitter.releasableERC20(await token.getAddress(), alice.address)).to.equal(300n);
  });

  it("splits native revenue by share", async () => {
    await admin.sendTransaction({ to: await splitter.getAddress(), value: 1000n });
    expect(await splitter.releasableNative(bob.address)).to.equal(400n);
    const before = await ethers.provider.getBalance(bob.address);
    await splitter.releaseNative(bob.address);
    const after = await ethers.provider.getBalance(bob.address);
    expect(after - before).to.equal(400n);
  });

  it("ignores non-payees and rejects empty releases", async () => {
    expect(await splitter.releasableNative(admin.address)).to.equal(0n);
    await expect(splitter.releaseNative(admin.address)).to.be.revertedWith("nothing");
  });
});
