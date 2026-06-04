const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RoyaltyMarketplace", function () {
  const PRICE = ethers.parseEther("100");
  const FEE_BPS = 500n; // 5%
  const URI = "ipfs://token";

  async function deploy() {
    const [deployer, seller, buyer, royaltyReceiver] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("RoyaltyNFT");
    // admin = deployer (gets MINTER_ROLE), default royalty 5% to royaltyReceiver.
    const nft = await NFT.deploy(
      "Royalty",
      "ROY",
      deployer.address,
      royaltyReceiver.address,
      FEE_BPS
    );

    const Pay = await ethers.getContractFactory("MockERC20");
    const pay = await Pay.deploy("Pay", "PAY");

    const Market = await ethers.getContractFactory("RoyaltyMarketplace");
    const market = await Market.deploy();

    // Mint token 0 to the seller.
    await nft.connect(deployer).mint(seller.address, URI);
    const tokenId = 0n;

    // Fund the buyer with pay tokens.
    await pay.mint(buyer.address, PRICE);

    return { nft, pay, market, deployer, seller, buyer, royaltyReceiver, tokenId };
  }

  async function listToken(ctx) {
    const { nft, pay, market, seller, tokenId } = ctx;
    await nft.connect(seller).approve(await market.getAddress(), tokenId);
    await market
      .connect(seller)
      .list(await nft.getAddress(), tokenId, await pay.getAddress(), PRICE);
    return 0n; // first listingId
  }

  it("list escrows the NFT into the marketplace", async function () {
    const ctx = await deploy();
    await listToken(ctx);

    expect(await ctx.nft.ownerOf(ctx.tokenId)).to.equal(await ctx.market.getAddress());

    const listing = await ctx.market.listings(0n);
    expect(listing.seller).to.equal(ctx.seller.address);
    expect(listing.price).to.equal(PRICE);
    expect(listing.active).to.equal(true);
  });

  it("buy splits payment between seller and royalty receiver and transfers the NFT", async function () {
    const ctx = await deploy();
    const listingId = await listToken(ctx);
    const { market, pay, nft, buyer, seller, royaltyReceiver, tokenId } = ctx;

    const royalty = (PRICE * FEE_BPS) / 10000n; // 5
    const sellerProceeds = PRICE - royalty;

    await pay.connect(buyer).approve(await market.getAddress(), PRICE);
    await market.connect(buyer).buy(listingId);

    expect(await pay.balanceOf(royaltyReceiver.address)).to.equal(royalty);
    expect(await pay.balanceOf(seller.address)).to.equal(sellerProceeds);
    expect(await pay.balanceOf(buyer.address)).to.equal(0n);
    expect(await nft.ownerOf(tokenId)).to.equal(buyer.address);
  });

  it("cancel returns the NFT to the seller", async function () {
    const ctx = await deploy();
    const listingId = await listToken(ctx);
    const { market, nft, seller, tokenId } = ctx;

    await market.connect(seller).cancel(listingId);

    expect(await nft.ownerOf(tokenId)).to.equal(seller.address);
    const listing = await market.listings(listingId);
    expect(listing.active).to.equal(false);
  });

  it("reverts when buying a cancelled listing", async function () {
    const ctx = await deploy();
    const listingId = await listToken(ctx);
    const { market, pay, buyer, seller } = ctx;

    await market.connect(seller).cancel(listingId);

    await pay.connect(buyer).approve(await market.getAddress(), PRICE);
    await expect(market.connect(buyer).buy(listingId)).to.be.revertedWith("inactive");
  });

  it("reverts when a non-seller tries to cancel", async function () {
    const ctx = await deploy();
    const listingId = await listToken(ctx);
    const { market, buyer } = ctx;

    await expect(market.connect(buyer).cancel(listingId)).to.be.revertedWith("not seller");
  });

  it("reverts when listing without approving the marketplace", async function () {
    const ctx = await deploy();
    const { nft, pay, market, seller, tokenId } = ctx;

    await expect(
      market
        .connect(seller)
        .list(await nft.getAddress(), tokenId, await pay.getAddress(), PRICE)
    ).to.be.reverted;
  });
});
