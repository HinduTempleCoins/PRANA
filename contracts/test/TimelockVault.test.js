const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TimelockVault", function () {
  let token, vault, alice, bob;
  const AMOUNT = 1000n;

  beforeEach(async () => {
    [alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Lock", "LCK");

    const V = await ethers.getContractFactory("TimelockVault");
    vault = await V.deploy();

    await token.mint(alice.address, AMOUNT * 10n);
    await token.connect(alice).approve(await vault.getAddress(), AMOUNT * 10n);
  });

  async function makeLock(signer, amount, secondsFromNow) {
    const unlock = (await time.latest()) + secondsFromNow;
    const tx = await vault.connect(signer).lock(await token.getAddress(), amount, unlock);
    const rc = await tx.wait();
    const ev = rc.logs.find((l) => l.fragment && l.fragment.name === "Locked");
    return { lockId: ev.args.lockId, unlock };
  }

  it("pulls tokens in on lock and blocks withdrawal before unlock", async () => {
    const vaultAddr = await vault.getAddress();
    const { lockId } = await makeLock(alice, AMOUNT, 1000);

    expect(await token.balanceOf(vaultAddr)).to.equal(AMOUNT);
    await expect(vault.connect(alice).withdraw(lockId)).to.be.revertedWith("still locked");
  });

  it("allows withdrawal after unlockTime, returning tokens to the locker", async () => {
    const { lockId, unlock } = await makeLock(alice, AMOUNT, 1000);
    const before = await token.balanceOf(alice.address);

    await time.increaseTo(unlock + 1);
    await vault.connect(alice).withdraw(lockId);

    expect(await token.balanceOf(alice.address)).to.equal(before + AMOUNT);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("only the lock owner can withdraw", async () => {
    const { lockId, unlock } = await makeLock(alice, AMOUNT, 1000);
    await time.increaseTo(unlock + 1);

    await expect(vault.connect(bob).withdraw(lockId)).to.be.revertedWith("not lock owner");
    // alice can still withdraw afterwards
    await vault.connect(alice).withdraw(lockId);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("reverts on double withdrawal", async () => {
    const { lockId, unlock } = await makeLock(alice, AMOUNT, 1000);
    await time.increaseTo(unlock + 1);

    await vault.connect(alice).withdraw(lockId);
    await expect(vault.connect(alice).withdraw(lockId)).to.be.revertedWith("already withdrawn");
  });

  it("supports multiple independent locks per user", async () => {
    const a = await makeLock(alice, AMOUNT, 500);
    const b = await makeLock(alice, AMOUNT * 2n, 1500);

    expect(await vault.userLockCount(alice.address)).to.equal(2n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(AMOUNT * 3n);

    // first matures, second still locked
    await time.increaseTo(a.unlock + 1);
    await vault.connect(alice).withdraw(a.lockId);
    await expect(vault.connect(alice).withdraw(b.lockId)).to.be.revertedWith("still locked");

    await time.increaseTo(b.unlock + 1);
    await vault.connect(alice).withdraw(b.lockId);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });
});
