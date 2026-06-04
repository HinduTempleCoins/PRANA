const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NFTFactoryWizard", function () {
  let wiz, admin, creator, royaltyReceiver, buyer;

  beforeEach(async () => {
    [admin, creator, royaltyReceiver, buyer] = await ethers.getSigners();
    const W = await ethers.getContractFactory("NFTFactoryWizard");
    wiz = await W.deploy();
  });

  it("deploys an owned collection, hands over all roles, keeps no backdoor", async () => {
    await wiz
      .connect(creator)
      .createCollection("Relics", "RLC", royaltyReceiver.address, 500);
    expect(await wiz.collectionCount()).to.equal(1n);

    const addr = await wiz.allCollections(0);
    expect(await wiz.creatorOf(addr)).to.equal(creator.address);

    const c = await ethers.getContractAt("RoyaltyNFT", addr);
    expect(await c.name()).to.equal("Relics");
    expect(await c.symbol()).to.equal("RLC");

    const MINTER = await c.MINTER_ROLE();
    const ADMIN = await c.DEFAULT_ADMIN_ROLE();
    // creator controls it; the factory holds nothing (no backdoor)
    expect(await c.hasRole(MINTER, creator.address)).to.equal(true);
    expect(await c.hasRole(ADMIN, creator.address)).to.equal(true);
    expect(await c.hasRole(MINTER, await wiz.getAddress())).to.equal(false);
    expect(await c.hasRole(ADMIN, await wiz.getAddress())).to.equal(false);
  });

  it("emits CollectionCreated with the royalty config", async () => {
    // The collection address is deterministic: created by the factory at its next nonce (1).
    const predicted = ethers.getCreateAddress({
      from: await wiz.getAddress(),
      nonce: 1,
    });
    await expect(
      wiz
        .connect(creator)
        .createCollection("Art", "ART", royaltyReceiver.address, 750)
    )
      .to.emit(wiz, "CollectionCreated")
      .withArgs(predicted, creator.address, "Art", "ART", royaltyReceiver.address, 750);
  });

  it("the creator can mint and EIP-2981 royalties resolve to the configured receiver", async () => {
    await wiz
      .connect(creator)
      .createCollection("Art", "ART", royaltyReceiver.address, 1000); // 10%
    const c = await ethers.getContractAt("RoyaltyNFT", await wiz.allCollections(0));

    await c.connect(creator).mint(buyer.address, "ipfs://token/0");
    expect(await c.ownerOf(0)).to.equal(buyer.address);
    expect(await c.tokenURI(0)).to.equal("ipfs://token/0");

    const [recv, amount] = await c.royaltyInfo(0, 1000n);
    expect(recv).to.equal(royaltyReceiver.address);
    expect(amount).to.equal(100n); // 10% of 1000

    // the factory itself cannot mint (no residual role)
    await expect(
      c.connect(admin).mint(buyer.address, "ipfs://nope")
    ).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
  });

  it("rejects a zero royalty receiver and an over-100% fee", async () => {
    await expect(
      wiz.connect(creator).createCollection("X", "X", ethers.ZeroAddress, 100)
    ).to.be.revertedWithCustomError(wiz, "ZeroRoyaltyReceiver");

    await expect(
      wiz
        .connect(creator)
        .createCollection("X", "X", royaltyReceiver.address, 10001)
    ).to.be.revertedWithCustomError(wiz, "FeeTooHigh");
  });
});
