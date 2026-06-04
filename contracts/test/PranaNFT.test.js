const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PranaNFT (ERC-721)", function () {
  let nft, admin, minter, user;

  beforeEach(async () => {
    [admin, minter, user] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("PranaNFT");
    nft = await NFT.deploy(admin.address);
  });

  it("has name/symbol and zero minted initially", async () => {
    expect(await nft.name()).to.equal("PRANA NFT");
    expect(await nft.symbol()).to.equal("PNFT");
    expect(await nft.minted()).to.equal(0n);
  });

  it("minter can mint with a tokenURI; ids auto-increment", async () => {
    await nft.mint(user.address, "ipfs://a");
    await nft.mint(user.address, "ipfs://b");
    expect(await nft.ownerOf(0)).to.equal(user.address);
    expect(await nft.ownerOf(1)).to.equal(user.address);
    expect(await nft.tokenURI(0)).to.equal("ipfs://a");
    expect(await nft.tokenURI(1)).to.equal("ipfs://b");
    expect(await nft.balanceOf(user.address)).to.equal(2n);
    expect(await nft.minted()).to.equal(2n);
  });

  it("non-minter cannot mint", async () => {
    await expect(nft.connect(user).mint(user.address, "ipfs://x")).to.be.reverted;
  });

  it("MINTER_ROLE can be granted", async () => {
    const MINTER = await nft.MINTER_ROLE();
    await nft.grantRole(MINTER, minter.address);
    await nft.connect(minter).mint(user.address, "ipfs://y");
    expect(await nft.ownerOf(0)).to.equal(user.address);
  });

  it("supports the ERC-721 and AccessControl interfaces", async () => {
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await nft.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
  });
});
