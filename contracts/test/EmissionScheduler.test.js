const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("EmissionScheduler", function () {
  let reward, admin, recipient;
  const PER = 100n;
  const EPOCH = 100; // seconds

  beforeEach(async () => {
    [admin, recipient] = await ethers.getSigners();
    const PoL = await ethers.getContractFactory("PoLToken");
    reward = await PoL.deploy(admin.address);
  });

  async function deploy(halvingEpochs) {
    const S = await ethers.getContractFactory("EmissionScheduler");
    const s = await S.deploy(await reward.getAddress(), recipient.address, PER, EPOCH, halvingEpochs);
    await reward.grantRole(await reward.MINTER_ROLE(), await s.getAddress());
    return s;
  }

  it("mints perEpoch for each elapsed epoch (no halving)", async () => {
    const s = await deploy(0);
    await time.increase(EPOCH * 3 + 5); // 3 full epochs elapsed
    await s.mintDue();
    expect(await reward.balanceOf(recipient.address)).to.equal(300n); // 3 * 100
  });

  it("applies halving when configured", async () => {
    const s = await deploy(1); // halve every epoch: 100 + 50 + 25 = 175
    await time.increase(EPOCH * 3 + 5);
    await s.mintDue();
    expect(await reward.balanceOf(recipient.address)).to.equal(175n);
  });

  it("reverts when nothing is due", async () => {
    const s = await deploy(0);
    await expect(s.mintDue()).to.be.revertedWith("nothing due");
  });
});
