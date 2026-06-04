const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BatchAirdrop", function () {
  let token, air, sender, r1, r2, r3;

  beforeEach(async () => {
    [sender, r1, r2, r3] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Prana", "PRANA");
    const Air = await ethers.getContractFactory("BatchAirdrop");
    air = await Air.deploy();

    await token.mint(sender.address, 1_000_000n);
  });

  it("distributes correctly to 3 recipients", async () => {
    const recipients = [r1.address, r2.address, r3.address];
    const amounts = [100n, 250n, 650n];
    const total = 1000n;

    await token.connect(sender).approve(await air.getAddress(), total);
    await expect(air.connect(sender).airdrop(await token.getAddress(), recipients, amounts))
      .to.emit(air, "Airdropped")
      .withArgs(await token.getAddress(), sender.address, 3n, total);

    expect(await token.balanceOf(r1.address)).to.equal(100n);
    expect(await token.balanceOf(r2.address)).to.equal(250n);
    expect(await token.balanceOf(r3.address)).to.equal(650n);
    // Contract holds nothing (stateless push distributor).
    expect(await token.balanceOf(await air.getAddress())).to.equal(0n);
  });

  it("reverts on length mismatch", async () => {
    await token.connect(sender).approve(await air.getAddress(), 1000n);
    await expect(
      air.connect(sender).airdrop(
        await token.getAddress(),
        [r1.address, r2.address],
        [100n]
      )
    ).to.be.revertedWithCustomError(air, "LengthMismatch");
  });

  it("reverts on empty recipients", async () => {
    await expect(
      air.connect(sender).airdrop(await token.getAddress(), [], [])
    ).to.be.revertedWithCustomError(air, "EmptyRecipients");
  });

  it("requires sufficient approval", async () => {
    // No approval granted -> the transferFrom pull fails.
    await expect(
      air.connect(sender).airdrop(
        await token.getAddress(),
        [r1.address, r2.address],
        [100n, 200n]
      )
    ).to.be.reverted;
  });

  it("airdropEqual sends the same amount to each recipient", async () => {
    const recipients = [r1.address, r2.address, r3.address];
    const amountEach = 500n;
    const total = amountEach * 3n;

    await token.connect(sender).approve(await air.getAddress(), total);
    await expect(air.connect(sender).airdropEqual(await token.getAddress(), recipients, amountEach))
      .to.emit(air, "Airdropped")
      .withArgs(await token.getAddress(), sender.address, 3n, total);

    expect(await token.balanceOf(r1.address)).to.equal(amountEach);
    expect(await token.balanceOf(r2.address)).to.equal(amountEach);
    expect(await token.balanceOf(r3.address)).to.equal(amountEach);
  });
});
