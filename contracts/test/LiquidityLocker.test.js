const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("LiquidityLocker", function () {
  let lp, locker, owner, other;
  const AMOUNT = 1000n;

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    lp = await Mock.deploy("LP Token", "LP");
    await lp.mint(owner.address, AMOUNT);

    const Locker = await ethers.getContractFactory("LiquidityLocker");
    locker = await Locker.deploy();

    await lp.connect(owner).approve(await locker.getAddress(), AMOUNT);
  });

  async function makeLock(amount = AMOUNT, secondsAhead = 1000, lockOwner = owner.address) {
    const unlockTime = (await time.latest()) + secondsAhead;
    await locker.connect(owner).lock(await lp.getAddress(), amount, unlockTime, lockOwner);
    return { id: 0, unlockTime };
  }

  it("locks tokens: pulls them in and records the lock", async () => {
    const { id, unlockTime } = await makeLock();

    expect(await lp.balanceOf(await locker.getAddress())).to.equal(AMOUNT);
    expect(await lp.balanceOf(owner.address)).to.equal(0n);
    expect(await locker.locksCount()).to.equal(1n);

    const l = await locker.getLock(id);
    expect(l.owner).to.equal(owner.address);
    expect(l.amount).to.equal(AMOUNT);
    expect(l.unlockTime).to.equal(BigInt(unlockTime));
    expect(l.withdrawn).to.equal(false);
  });

  it("unlock fails before the unlock time, succeeds after", async () => {
    const { id, unlockTime } = await makeLock();

    await expect(locker.connect(owner).unlock(id)).to.be.revertedWith("still locked");

    await time.increaseTo(unlockTime);
    await locker.connect(owner).unlock(id);

    expect(await lp.balanceOf(owner.address)).to.equal(AMOUNT);
    expect((await locker.getLock(id)).withdrawn).to.equal(true);

    // cannot withdraw twice
    await expect(locker.connect(owner).unlock(id)).to.be.revertedWith("withdrawn");
  });

  it("only the owner can unlock", async () => {
    const { id, unlockTime } = await makeLock();
    await time.increaseTo(unlockTime);
    await expect(locker.connect(other).unlock(id)).to.be.revertedWith("not owner");
  });

  it("extend can only lengthen the lock, never shorten it", async () => {
    const { id, unlockTime } = await makeLock();

    // shortening reverts
    await expect(locker.connect(owner).extend(id, unlockTime - 1)).to.be.revertedWith("must lengthen");
    // equal reverts (must strictly increase)
    await expect(locker.connect(owner).extend(id, unlockTime)).to.be.revertedWith("must lengthen");

    // lengthening works
    const later = unlockTime + 5000;
    await locker.connect(owner).extend(id, later);
    expect((await locker.getLock(id)).unlockTime).to.equal(BigInt(later));

    // and the extension is enforced: old time is no longer enough
    await time.increaseTo(unlockTime + 1);
    await expect(locker.connect(owner).unlock(id)).to.be.revertedWith("still locked");
  });

  it("only the owner can extend", async () => {
    const { id, unlockTime } = await makeLock();
    await expect(locker.connect(other).extend(id, unlockTime + 100)).to.be.revertedWith("not owner");
  });
});
