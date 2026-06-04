const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("DutchAuction (linear declining-price ERC-721 sale paid in ERC-20)", function () {
  let nft, pay, auction, seller, buyer, stranger;
  let tokenId;

  const START_PRICE = ethers.parseEther("100");
  const END_PRICE = ethers.parseEther("20");
  const DURATION = 1000n; // seconds

  // Generous allowance so the buyer can always cover the asking price.
  const BUYER_FUNDS = ethers.parseEther("1000");

  beforeEach(async () => {
    [seller, buyer, stranger] = await ethers.getSigners();

    // Auctioned NFT: PranaNFT, admin = seller (admin also holds MINTER_ROLE).
    const PranaNFT = await ethers.getContractFactory("PranaNFT");
    nft = await PranaNFT.deploy(seller.address);

    // Mint token id 0 to the seller.
    await nft.connect(seller).mint(seller.address, "ipfs://prana-art");
    tokenId = 0n;

    // Pay token.
    const Mock = await ethers.getContractFactory("MockERC20");
    pay = await Mock.deploy("Pay Token", "PAY");
    await pay.mint(buyer.address, BUYER_FUNDS);

    const DutchAuction = await ethers.getContractFactory("DutchAuction");
    auction = await DutchAuction.deploy();

    // Seller approves & starts the auction (escrows the NFT).
    await nft.connect(seller).approve(await auction.getAddress(), tokenId);
    await auction
      .connect(seller)
      .start(
        await nft.getAddress(),
        tokenId,
        await pay.getAddress(),
        START_PRICE,
        END_PRICE,
        DURATION
      );

    // Buyer pre-approves the auction to pull the pay token.
    await pay.connect(buyer).approve(await auction.getAddress(), BUYER_FUNDS);
  });

  it("escrows the NFT on start()", async () => {
    expect(await nft.ownerOf(tokenId)).to.equal(await auction.getAddress());
    expect(await auction.state()).to.equal(1n); // Live
  });

  it("price declines linearly over time (band at midpoint)", async () => {
    const startTime = await auction.startTime();
    // Jump to exactly the midpoint of the duration.
    await time.setNextBlockTimestamp(startTime + DURATION / 2n);
    await ethers.provider.send("evm_mine", []);

    const mid = (START_PRICE + END_PRICE) / 2n; // 60 ether
    expect(await auction.currentPrice()).to.equal(mid);

    // And the price is strictly between the bounds.
    expect(await auction.currentPrice()).to.be.lt(START_PRICE);
    expect(await auction.currentPrice()).to.be.gt(END_PRICE);
  });

  it("price floors at endPrice after the duration elapses", async () => {
    const startTime = await auction.startTime();
    // Past the end of the auction window.
    await time.setNextBlockTimestamp(startTime + DURATION + 500n);
    await ethers.provider.send("evm_mine", []);

    expect(await auction.currentPrice()).to.equal(END_PRICE);
  });

  it("buy() pays the current price to the seller and transfers the NFT to the buyer", async () => {
    const startTime = await auction.startTime();
    // Settle at the midpoint so the expected price is the clean 60-ether band.
    await time.setNextBlockTimestamp(startTime + DURATION / 2n);

    const price = (START_PRICE + END_PRICE) / 2n;
    const sellerBefore = await pay.balanceOf(seller.address);
    const buyerBefore = await pay.balanceOf(buyer.address);

    await expect(auction.connect(buyer).buy())
      .to.emit(auction, "Bought")
      .withArgs(buyer.address, price);

    // NFT moved to the buyer.
    expect(await nft.ownerOf(tokenId)).to.equal(buyer.address);
    // Pay token moved buyer -> seller, exactly the current price.
    expect(await pay.balanceOf(seller.address)).to.equal(sellerBefore + price);
    expect(await pay.balanceOf(buyer.address)).to.equal(buyerBefore - price);
    expect(await auction.state()).to.equal(2n); // Sold

    // No second sale.
    await expect(auction.connect(stranger).buy()).to.be.revertedWith("not live");
  });

  it("cancel() returns the NFT to the seller and blocks buy()", async () => {
    // Only the seller may cancel.
    await expect(auction.connect(stranger).cancel()).to.be.revertedWith("not seller");

    await expect(auction.connect(seller).cancel())
      .to.emit(auction, "Cancelled")
      .withArgs(seller.address);

    expect(await nft.ownerOf(tokenId)).to.equal(seller.address);
    expect(await auction.state()).to.equal(3n); // Cancelled

    // Buying is no longer possible.
    await expect(auction.connect(buyer).buy()).to.be.revertedWith("not live");
  });
});
