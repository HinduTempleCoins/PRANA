const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BurnForHashrate (virtual mining)", function () {
  let input, output, bfh, admin, a, b;
  const REWARD = 800n;
  const EPOCH = 1000;

  beforeEach(async () => {
    [admin, a, b] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    input = await Mock.deploy("In", "IN");
    const PoL = await ethers.getContractFactory("PoLToken");
    output = await PoL.deploy(admin.address);
    const BFH = await ethers.getContractFactory("BurnForHashrate");
    bfh = await BFH.deploy(await input.getAddress(), await output.getAddress(), REWARD, EPOCH);
    await output.grantRole(await output.MINTER_ROLE(), await bfh.getAddress());

    await input.mint(a.address, 1000n);
    await input.mint(b.address, 1000n);
    await input.connect(a).approve(await bfh.getAddress(), 1000n);
    await input.connect(b).approve(await bfh.getAddress(), 1000n);
  });

  it("splits the epoch reward pro-rata to burners; difficulty rises with total burn", async () => {
    await bfh.connect(a).burn(300n); // epoch 0
    await bfh.connect(b).burn(100n); // epoch 0, total 400
    expect(await input.totalSupply()).to.equal(1600n); // 400 burned of 2000

    await time.increase(EPOCH + 1); // into epoch 1

    await bfh.connect(a).claim(0);
    await bfh.connect(b).claim(0);
    expect(await output.balanceOf(a.address)).to.equal(600n); // 800 * 300/400
    expect(await output.balanceOf(b.address)).to.equal(200n); // 800 * 100/400
  });

  it("cannot claim the current (unfinished) epoch, nor double-claim", async () => {
    await bfh.connect(a).burn(100n);
    await expect(bfh.connect(a).claim(0)).to.be.revertedWith("epoch not ended");
    await time.increase(EPOCH + 1);
    await bfh.connect(a).claim(0);
    await expect(bfh.connect(a).claim(0)).to.be.revertedWith("claimed");
  });
});
