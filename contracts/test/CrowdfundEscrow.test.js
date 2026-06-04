const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CrowdfundEscrow (all-or-nothing ERC-20 crowdfund)", function () {
  let token, fund, beneficiary, alice, bob, stranger;
  const GOAL = 1000n;
  const ALICE_PLEDGE = 600n;
  const BOB_PLEDGE = 500n;

  let deadline;

  async function deploy(goal) {
    const now = await time.latest();
    deadline = now + 7 * 24 * 60 * 60; // 1 week out
    const Fund = await ethers.getContractFactory("CrowdfundEscrow");
    fund = await Fund.deploy(
      await token.getAddress(),
      beneficiary.address,
      goal,
      deadline
    );
    const fundAddr = await fund.getAddress();
    await token.connect(alice).approve(fundAddr, ALICE_PLEDGE);
    await token.connect(bob).approve(fundAddr, BOB_PLEDGE);
  }

  beforeEach(async () => {
    [beneficiary, alice, bob, stranger] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Crowd Token", "CRWD");
    await token.mint(alice.address, ALICE_PLEDGE);
    await token.mint(bob.address, BOB_PLEDGE);

    await deploy(GOAL);
  });

  it("records contributions and accrues the total raised", async () => {
    await fund.connect(alice).contribute(ALICE_PLEDGE);
    await fund.connect(bob).contribute(BOB_PLEDGE);

    expect(await fund.contributions(alice.address)).to.equal(ALICE_PLEDGE);
    expect(await fund.contributions(bob.address)).to.equal(BOB_PLEDGE);
    expect(await fund.totalRaised()).to.equal(ALICE_PLEDGE + BOB_PLEDGE);
    expect(await token.balanceOf(await fund.getAddress())).to.equal(
      ALICE_PLEDGE + BOB_PLEDGE
    );
  });

  it("success path: beneficiary claims everything and refunds are blocked", async () => {
    await fund.connect(alice).contribute(ALICE_PLEDGE);
    await fund.connect(bob).contribute(BOB_PLEDGE); // total 1100 >= 1000

    await time.increaseTo(deadline + 1);

    expect(await fund.succeeded()).to.equal(true);

    await expect(fund.connect(beneficiary).claim())
      .to.emit(fund, "Claimed")
      .withArgs(beneficiary.address, GOAL + 100n);

    expect(await token.balanceOf(beneficiary.address)).to.equal(
      ALICE_PLEDGE + BOB_PLEDGE
    );
    // Refunds rejected because the goal was met.
    await expect(fund.connect(alice).refund()).to.be.revertedWithCustomError(
      fund,
      "GoalMet"
    );
  });

  it("failure path: contributors refund their pledge and claim is blocked", async () => {
    await fund.connect(alice).contribute(ALICE_PLEDGE); // total 600 < 1000

    await time.increaseTo(deadline + 1);

    expect(await fund.succeeded()).to.equal(false);

    await expect(fund.connect(beneficiary).claim()).to.be.revertedWithCustomError(
      fund,
      "GoalNotMet"
    );

    await expect(fund.connect(alice).refund())
      .to.emit(fund, "Refunded")
      .withArgs(alice.address, ALICE_PLEDGE);

    expect(await token.balanceOf(alice.address)).to.equal(ALICE_PLEDGE);
    expect(await fund.contributions(alice.address)).to.equal(0n);
  });

  it("reverts when contributing after the deadline", async () => {
    await time.increaseTo(deadline + 1);
    await expect(
      fund.connect(alice).contribute(ALICE_PLEDGE)
    ).to.be.revertedWithCustomError(fund, "FundingClosed");
  });

  it("reverts on a double refund", async () => {
    await fund.connect(alice).contribute(ALICE_PLEDGE); // total 600 < 1000

    await time.increaseTo(deadline + 1);

    await fund.connect(alice).refund();
    await expect(fund.connect(alice).refund()).to.be.revertedWithCustomError(
      fund,
      "NothingToRefund"
    );
  });

  it("reverts on a double claim", async () => {
    await fund.connect(alice).contribute(ALICE_PLEDGE);
    await fund.connect(bob).contribute(BOB_PLEDGE); // total 1100 >= 1000

    await time.increaseTo(deadline + 1);

    await fund.connect(beneficiary).claim();
    await expect(fund.connect(beneficiary).claim()).to.be.revertedWithCustomError(
      fund,
      "AlreadyClaimed"
    );
  });
});
