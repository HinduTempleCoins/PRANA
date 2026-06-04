const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("GachaMint", function () {
  let gacha, pay, admin, treasury, user;
  const PRICE = ethers.parseEther("10");
  const NAMES = ["Common", "Rare", "Legendary"];
  const WEIGHTS = [70n, 25n, 5n];
  const PITY = 0; // pity disabled for deterministic odds tests

  beforeEach(async function () {
    [admin, treasury, user] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    pay = await MockERC20.deploy("Pay", "PAY");
    await pay.waitForDeployment();

    const GachaMint = await ethers.getContractFactory("GachaMint");
    gacha = await GachaMint.deploy(
      "Gacha NFT",
      "GACHA",
      await pay.getAddress(),
      PRICE,
      treasury.address,
      NAMES,
      WEIGHTS,
      PITY,
      admin.address
    );
    await gacha.waitForDeployment();

    // Fund and approve the user.
    await pay.mint(user.address, ethers.parseEther("1000"));
    await pay
      .connect(user)
      .approve(await gacha.getAddress(), ethers.MaxUint256);
  });

  it("commit charges the price to the treasury", async function () {
    const before = await pay.balanceOf(treasury.address);
    await gacha.connect(user)["commit()"]();
    const after = await pay.balanceOf(treasury.address);

    expect(after - before).to.equal(PRICE);
    expect(await gacha.commits(user.address)).to.be.gt(0n);
  });

  it("reveal before the next block reverts (TooEarly)", async function () {
    await gacha.connect(user)["commit()"]();
    // Same block / next block: blockhash(commitBlock+1) not yet available.
    await expect(gacha.connect(user).reveal()).to.be.revertedWithCustomError(
      gacha,
      "TooEarly"
    );
  });

  it("reveal after mining a block mints an NFT with a valid rarity", async function () {
    await gacha.connect(user)["commit()"]();
    await mine(2); // advance past commitBlock+1 so its blockhash is available

    const tx = await gacha.connect(user).reveal();
    await tx.wait();

    expect(await gacha.balanceOf(user.address)).to.equal(1n);
    expect(await gacha.ownerOf(0)).to.equal(user.address);

    const rarity = await gacha.rarityOf(0);
    expect(rarity).to.be.gte(0n);
    expect(rarity).to.be.lt(BigInt(NAMES.length));

    // commit cleared
    expect(await gacha.commits(user.address)).to.equal(0n);
  });

  it("odds view returns the configured weights and names (disclosed)", async function () {
    const w = await gacha.rarityWeights();
    expect(w).to.deep.equal(WEIGHTS);

    const n = await gacha.rarityNames();
    expect(n).to.deep.equal(NAMES);

    expect(await gacha.totalWeight()).to.equal(100n);
    expect(await gacha.rarityCount()).to.equal(BigInt(NAMES.length));
    expect(await gacha.rarityName(2)).to.equal("Legendary");
    expect(await gacha.rarityWeight(0)).to.equal(70n);
  });

  it("double-reveal reverts (commit cleared after first reveal)", async function () {
    await gacha.connect(user)["commit()"]();
    await mine(2);
    await gacha.connect(user).reveal();

    await expect(gacha.connect(user).reveal()).to.be.revertedWithCustomError(
      gacha,
      "NoCommit"
    );
  });

  it("cannot open a second commit while one is open", async function () {
    await gacha.connect(user)["commit()"]();
    await expect(
      gacha.connect(user)["commit()"]()
    ).to.be.revertedWithCustomError(gacha, "CommitOpen");
  });
});
