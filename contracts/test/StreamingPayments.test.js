const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("StreamingPayments", function () {
  let token, stream, sender, recipient, other;
  const TOTAL = 1000n;     // tokens to stream
  const DURATION = 1000;   // seconds (TOTAL % DURATION == 0 -> rate = 1/sec)

  let start, stop;

  beforeEach(async () => {
    [sender, recipient, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Stream", "STRM");
    await token.mint(sender.address, TOTAL);

    const SP = await ethers.getContractFactory("StreamingPayments");
    stream = await SP.deploy();

    start = (await time.latest()) + 10;
    stop = start + DURATION;

    await token.connect(sender).approve(await stream.getAddress(), TOTAL);
    await stream
      .connect(sender)
      .createStream(recipient.address, await token.getAddress(), TOTAL, start, stop);
  });

  it("pulls the deposit and streams nothing before start", async () => {
    expect(await token.balanceOf(await stream.getAddress())).to.equal(TOTAL);
    expect(await token.balanceOf(sender.address)).to.equal(0n);
    expect(await stream.withdrawable(0)).to.equal(0n);
  });

  it("streams ~half at the midpoint (tolerance band)", async () => {
    await time.increaseTo(start + DURATION / 2);
    const w = await stream.withdrawable(0);
    // exactly 500 at start+500; tx/read may land a second or two late
    expect(w >= 500n && w <= 503n).to.equal(true);
  });

  it("is fully withdrawable after stop", async () => {
    await time.increaseTo(stop + 5);
    expect(await stream.withdrawable(0)).to.equal(TOTAL);
  });

  it("lets the recipient withdraw and transfers tokens", async () => {
    await time.increaseTo(start + DURATION / 2);
    await stream.connect(recipient).withdraw(0, 400n);
    expect(await token.balanceOf(recipient.address)).to.equal(400n);

    // withdrawable drops by what was taken; still roughly the remaining ~100 at midpoint
    const w = await stream.withdrawable(0);
    expect(w >= 100n && w <= 105n).to.equal(true);

    // cannot pull more than is currently streamed
    await expect(stream.connect(recipient).withdraw(0, TOTAL)).to.be.revertedWith(
      "exceeds withdrawable"
    );
    // only the recipient may withdraw
    await expect(stream.connect(other).withdraw(0, 1n)).to.be.revertedWith("not recipient");
  });

  it("cancel splits streamed-to-recipient and refunds the rest to the sender", async () => {
    await time.increaseTo(start + DURATION / 2);
    await stream.connect(sender).cancelStream(0);

    const rBal = await token.balanceOf(recipient.address);
    const sBal = await token.balanceOf(sender.address);

    // recipient gets ~half, sender refunded ~half; bands for the 1-2s mining slack
    expect(rBal >= 500n && rBal <= 503n).to.equal(true);
    expect(sBal >= 497n && sBal <= 500n).to.equal(true);
    // contract fully drained, nothing left unaccounted
    expect(rBal + sBal).to.equal(TOTAL);
    expect(await token.balanceOf(await stream.getAddress())).to.equal(0n);

    // stream is now inactive
    await expect(stream.connect(recipient).withdraw(0, 1n)).to.be.revertedWith("inactive");
  });
});
