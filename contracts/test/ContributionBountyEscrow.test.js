const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ContributionBountyEscrow", function () {
  let token, esc, admin, sponsor, worker, outsider;

  beforeEach(async () => {
    [admin, sponsor, worker, outsider] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Bnty", "BNT");
    const E = await ethers.getContractFactory("ContributionBountyEscrow");
    esc = await E.deploy(await token.getAddress(), admin.address);
    await token.mint(sponsor.address, 1000n);
    await token.connect(sponsor).approve(await esc.getAddress(), 1000n);
  });

  it("escrows a bounty and the attestor releases it to the worker", async () => {
    await esc.connect(sponsor).post(500n);
    expect(await token.balanceOf(await esc.getAddress())).to.equal(500n);
    await esc.connect(admin).attestAndRelease(0, worker.address);
    expect(await token.balanceOf(worker.address)).to.equal(500n);
  });

  it("lets the sponsor cancel an unclaimed bounty for a refund", async () => {
    await esc.connect(sponsor).post(300n);
    await esc.connect(sponsor).cancel(0);
    expect(await token.balanceOf(sponsor.address)).to.equal(1000n);
  });

  it("blocks non-attestor release and double release", async () => {
    await esc.connect(sponsor).post(100n);
    await expect(esc.connect(outsider).attestAndRelease(0, worker.address)).to.be.reverted;
    await esc.connect(admin).attestAndRelease(0, worker.address);
    await expect(esc.connect(admin).attestAndRelease(0, worker.address)).to.be.revertedWith("closed");
  });
});
