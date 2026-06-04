const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NFTFractionalizer", function () {
  const SHARES = 1000n;
  let nft, factory, admin, owner, other;
  let nftAddr, factoryAddr;

  // Mint one NFT to `to` and return its id (PranaNFT auto-increments from 0).
  async function mintTo(to) {
    const id = await nft.minted();
    await nft.mint(to.address, "ipfs://art");
    return id;
  }

  // Fractionalize token `id` (owned by `from`) into `SHARES` fractional tokens.
  // Returns the deployed FractionalVault instance.
  async function fractionalize(from, id) {
    // The depositor approves the factory (a known address) for the specific token.
    await nft.connect(from).approve(factoryAddr, id);
    const vaultAddr = await factory
      .connect(from)
      .fractionalize.staticCall(nftAddr, id, SHARES, "Fraction", "FRAC");
    await factory.connect(from).fractionalize(nftAddr, id, SHARES, "Fraction", "FRAC");
    return ethers.getContractAt("FractionalVault", vaultAddr);
  }

  beforeEach(async () => {
    [admin, owner, other] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("PranaNFT");
    nft = await NFT.deploy(admin.address);
    nftAddr = await nft.getAddress();

    const Factory = await ethers.getContractFactory("NFTFractionalizer");
    factory = await Factory.deploy();
    factoryAddr = await factory.getAddress();
  });

  it("mints shares to the depositor and escrows the NFT in the vault", async () => {
    const id = await mintTo(owner);
    const vault = await fractionalize(owner, id);
    const vaultAddr = await vault.getAddress();

    expect(await vault.balanceOf(owner.address)).to.equal(SHARES);
    expect(await vault.totalSupply()).to.equal(SHARES);
    expect(await nft.ownerOf(id)).to.equal(vaultAddr); // NFT is locked in the vault
    expect(await factory.vaultCount()).to.equal(1n);
  });

  it("a partial holder cannot redeem", async () => {
    const id = await mintTo(owner);
    const vault = await fractionalize(owner, id);

    // Move some shares away so nobody holds 100%.
    await vault.connect(owner).transfer(other.address, 1n);

    await expect(vault.connect(owner).redeem()).to.be.revertedWith("need 100% of shares");
    await expect(vault.connect(other).redeem()).to.be.revertedWith("need 100% of shares");
  });

  it("a full (100%) holder redeems and gets the NFT back", async () => {
    const id = await mintTo(owner);
    const vault = await fractionalize(owner, id);

    // Concentrate the whole supply in `other`, then redeem.
    await vault.connect(owner).transfer(other.address, SHARES);
    expect(await vault.balanceOf(other.address)).to.equal(SHARES);

    await vault.connect(other).redeem();

    expect(await nft.ownerOf(id)).to.equal(other.address); // NFT reclaimed
    expect(await vault.totalSupply()).to.equal(0n); // all shares burned
    await expect(vault.connect(other).redeem()).to.be.revertedWith("already redeemed");
  });

  it("fractional shares are transferable ERC-20 tokens", async () => {
    const id = await mintTo(owner);
    const vault = await fractionalize(owner, id);

    await vault.connect(owner).transfer(other.address, 400n);
    expect(await vault.balanceOf(owner.address)).to.equal(SHARES - 400n);
    expect(await vault.balanceOf(other.address)).to.equal(400n);

    // approve / transferFrom path also works
    await vault.connect(other).approve(owner.address, 100n);
    await vault.connect(owner).transferFrom(other.address, admin.address, 100n);
    expect(await vault.balanceOf(other.address)).to.equal(300n);
    expect(await vault.balanceOf(admin.address)).to.equal(100n);
  });

  it("exposes ERC-20 metadata from the fractionalize call", async () => {
    const id = await mintTo(owner);
    const vault = await fractionalize(owner, id);

    expect(await vault.name()).to.equal("Fraction");
    expect(await vault.symbol()).to.equal("FRAC");
    expect(await vault.totalShares()).to.equal(SHARES);
    expect(await vault.tokenId()).to.equal(id);
  });
});
