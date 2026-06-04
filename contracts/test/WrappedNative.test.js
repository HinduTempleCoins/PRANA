const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WrappedNative (WPRANA)", function () {
  let w, a, b;

  beforeEach(async () => {
    [a, b] = await ethers.getSigners();
    const W = await ethers.getContractFactory("WrappedNative");
    w = await W.deploy();
  });

  it("wraps via deposit() and via receive()", async () => {
    await w.connect(a).deposit({ value: 1000n });
    expect(await w.balanceOf(a.address)).to.equal(1000n);
    // plain send triggers receive() -> deposit()
    await a.sendTransaction({ to: await w.getAddress(), value: 500n });
    expect(await w.balanceOf(a.address)).to.equal(1500n);
    expect(await w.totalSupply()).to.equal(1500n);
  });

  it("unwraps via withdraw()", async () => {
    await w.connect(a).deposit({ value: 1000n });
    await w.connect(a).withdraw(400n);
    expect(await w.balanceOf(a.address)).to.equal(600n);
    expect(await w.totalSupply()).to.equal(600n);
  });

  it("reverts withdrawing more than balance", async () => {
    await expect(w.connect(a).withdraw(1n)).to.be.revertedWith("insufficient");
  });

  it("transfers and respects allowance", async () => {
    await w.connect(a).deposit({ value: 1000n });
    await w.connect(a).transfer(b.address, 300n);
    expect(await w.balanceOf(b.address)).to.equal(300n);

    await w.connect(a).approve(b.address, 200n);
    await w.connect(b).transferFrom(a.address, b.address, 200n);
    expect(await w.balanceOf(b.address)).to.equal(500n);
    expect(await w.allowance(a.address, b.address)).to.equal(0n);
  });
});
