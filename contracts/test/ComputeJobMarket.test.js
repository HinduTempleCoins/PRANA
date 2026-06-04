const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ComputeJobMarket", function () {
  let token, market, admin, requester, worker, outsider;
  const SPEC = ethers.encodeBytes32String("ai-inference");

  beforeEach(async () => {
    [admin, requester, worker, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Pay", "PAY");

    const Market = await ethers.getContractFactory("ComputeJobMarket");
    market = await Market.deploy(admin.address); // admin holds VERIFIER_ROLE

    await token.mint(requester.address, 1000n);
    await token.connect(requester).approve(await market.getAddress(), 1000n);
  });

  it("escrows the reward when a job is posted", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    expect(await token.balanceOf(await market.getAddress())).to.equal(500n);
    expect(await token.balanceOf(requester.address)).to.equal(500n);

    const job = await market.jobs(0);
    expect(job.requester).to.equal(requester.address);
    expect(job.status).to.equal(1n); // Open
  });

  it("assigns the worker on accept", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    await market.connect(worker).accept(0);

    const job = await market.jobs(0);
    expect(job.worker).to.equal(worker.address);
    expect(job.status).to.equal(2n); // Assigned
  });

  it("pays the worker when the verifier settles success", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    await market.connect(worker).accept(0);
    await market.connect(admin).settle(0, true);

    expect(await token.balanceOf(worker.address)).to.equal(500n);
    expect(await token.balanceOf(await market.getAddress())).to.equal(0n);
    expect((await market.jobs(0)).status).to.equal(3n); // Completed
  });

  it("refunds the requester when the verifier settles failure", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    await market.connect(worker).accept(0);
    await market.connect(admin).settle(0, false);

    expect(await token.balanceOf(requester.address)).to.equal(1000n);
    expect(await token.balanceOf(worker.address)).to.equal(0n);
    expect((await market.jobs(0)).status).to.equal(4n); // Failed
  });

  it("reverts when a non-verifier tries to settle", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    await market.connect(worker).accept(0);
    await expect(market.connect(outsider).settle(0, true)).to.be.reverted;
  });

  it("reverts cancel after the job has been accepted", async () => {
    await market.connect(requester).postJob(await token.getAddress(), 500n, SPEC);
    await market.connect(worker).accept(0);
    await expect(market.connect(requester).cancel(0)).to.be.revertedWith("not open");
  });
});
