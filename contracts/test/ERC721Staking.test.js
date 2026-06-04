const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ERC721Staking", function () {
  const RATE = 1_000_000_000n; // reward units per NFT per second
  let nft, reward, staking, admin, user, other;

  // Mint `n` NFTs to `to`, returning their token ids (PranaNFT auto-increments from 0).
  async function mintTo(to, n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = await nft.minted();
      await nft.mint(to.address, "ipfs://x");
      ids.push(id);
    }
    return ids;
  }

  beforeEach(async () => {
    [admin, user, other] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("PranaNFT");
    nft = await NFT.deploy(admin.address);

    const Mock = await ethers.getContractFactory("MockERC20");
    reward = await Mock.deploy("Reward", "RWD");

    const Staking = await ethers.getContractFactory("ERC721Staking");
    staking = await Staking.deploy(
      await nft.getAddress(),
      await reward.getAddress(),
      RATE
    );

    // Pre-fund the staking contract with reward tokens.
    await reward.mint(admin.address, 10n ** 24n);
    await reward.connect(admin).approve(await staking.getAddress(), 10n ** 24n);
    await staking.connect(admin).fundRewards(10n ** 24n);
  });

  it("accrues ~rate*time*count after staking (tolerance band)", async () => {
    const ids = await mintTo(user, 3);
    await nft.connect(user).setApprovalForAll(await staking.getAddress(), true);
    await staking.connect(user).stake(ids);

    await time.increase(1000);
    const earned = await staking.earned(user.address);

    const expected = RATE * 1000n * 3n;
    const lo = (expected * 99n) / 100n;
    const hi = (expected * 101n) / 100n;
    expect(earned >= lo && earned <= hi).to.equal(true);
  });

  it("claim transfers accrued reward to the staker", async () => {
    const ids = await mintTo(user, 2);
    await nft.connect(user).setApprovalForAll(await staking.getAddress(), true);
    await staking.connect(user).stake(ids);

    await time.increase(500);
    const before = await reward.balanceOf(user.address);
    await staking.connect(user).claim();
    const gained = (await reward.balanceOf(user.address)) - before;

    const expected = RATE * 500n * 2n;
    const lo = (expected * 98n) / 100n;
    const hi = (expected * 102n) / 100n;
    expect(gained >= lo && gained <= hi).to.equal(true);
  });

  it("withdraw returns the NFTs and stops accrual", async () => {
    const ids = await mintTo(user, 2);
    await nft.connect(user).setApprovalForAll(await staking.getAddress(), true);
    await staking.connect(user).stake(ids);
    expect(await nft.ownerOf(ids[0])).to.equal(await staking.getAddress());

    await time.increase(300);
    await staking.connect(user).withdraw(ids);

    // NFTs are back with the user.
    expect(await nft.ownerOf(ids[0])).to.equal(user.address);
    expect(await nft.ownerOf(ids[1])).to.equal(user.address);

    // Accrual frozen: earned does not grow after full withdrawal.
    const e1 = await staking.earned(user.address);
    await time.increase(1000);
    const e2 = await staking.earned(user.address);
    expect(e2).to.equal(e1);
  });

  it("cannot withdraw an NFT you did not stake", async () => {
    const userIds = await mintTo(user, 1);
    const otherIds = await mintTo(other, 1);

    await nft.connect(user).setApprovalForAll(await staking.getAddress(), true);
    await nft.connect(other).setApprovalForAll(await staking.getAddress(), true);

    await staking.connect(user).stake(userIds);
    await staking.connect(other).stake(otherIds);

    // user tries to withdraw other's token id.
    await expect(
      staking.connect(user).withdraw(otherIds)
    ).to.be.revertedWith("not your stake");
  });

  it("claim reverts when nothing has accrued", async () => {
    await expect(staking.connect(user).claim()).to.be.revertedWith("nothing to claim");
  });
});
