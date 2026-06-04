const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RoyaltyNFT", function () {
  let nft, admin, minter, receiver, user;
  const FEE_BPS = 500; // 5%

  beforeEach(async function () {
    [admin, minter, receiver, user] = await ethers.getSigners();
    const RoyaltyNFT = await ethers.getContractFactory("RoyaltyNFT");
    nft = await RoyaltyNFT.deploy(
      "Prana NFT",
      "PNFT",
      admin.address,
      receiver.address,
      FEE_BPS
    );
    await nft.waitForDeployment();
  });

  it("mints with an auto-incremented id and per-token URI", async function () {
    await nft.connect(admin).mint(user.address, "ipfs://token-0");
    await nft.connect(admin).mint(user.address, "ipfs://token-1");

    expect(await nft.ownerOf(0)).to.equal(user.address);
    expect(await nft.ownerOf(1)).to.equal(user.address);
    expect(await nft.tokenURI(0)).to.equal("ipfs://token-0");
    expect(await nft.tokenURI(1)).to.equal("ipfs://token-1");
  });

  it("returns correct EIP-2981 royalty (5% of sale price)", async function () {
    await nft.connect(admin).mint(user.address, "ipfs://token-0");

    const salePrice = ethers.parseEther("10");
    const [royReceiver, royAmount] = await nft.royaltyInfo(0, salePrice);

    expect(royReceiver).to.equal(receiver.address);
    expect(royAmount).to.equal(ethers.parseEther("0.5")); // 5% of 10
  });

  it("honors per-token royalty override set by admin", async function () {
    await nft.connect(admin).mint(user.address, "ipfs://token-0");
    await nft.connect(admin).setTokenRoyalty(0, user.address, 1000); // 10%

    const salePrice = ethers.parseEther("10");
    const [royReceiver, royAmount] = await nft.royaltyInfo(0, salePrice);

    expect(royReceiver).to.equal(user.address);
    expect(royAmount).to.equal(ethers.parseEther("1")); // 10% of 10
  });

  it("reverts when a non-minter tries to mint", async function () {
    await expect(
      nft.connect(user).mint(user.address, "ipfs://nope")
    ).to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount");
  });

  it("supportsInterface for ERC-2981 and ERC-721", async function () {
    expect(await nft.supportsInterface("0x2a55205a")).to.equal(true); // ERC2981
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await nft.supportsInterface("0xffffffff")).to.equal(false);
  });
});
