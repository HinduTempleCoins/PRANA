const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CreatureNFT (breedable ERC-721)", function () {
  let nft, admin, owner, other;

  beforeEach(async () => {
    [admin, owner, other] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("CreatureNFT");
    nft = await NFT.deploy(admin.address);
  });

  it("genesis mint sets deterministic traits and birthTime", async () => {
    await nft.mintGenesis(owner.address); // token 0
    expect(await nft.ownerOf(0)).to.equal(owner.address);
    expect(await nft.minted()).to.equal(1n);

    const expected = ethers.toBigInt(
      ethers.solidityPackedKeccak256(["uint256", "address"], [0, owner.address])
    );
    expect(await nft.traitsOf(0)).to.equal(expected);
    expect(await nft.traitsOf(0)).to.not.equal(0n);

    const latest = await time.latest();
    expect(await nft.birthTimeOf(0)).to.equal(BigInt(latest));
    expect(await nft.canBreed(0)).to.equal(true);
  });

  it("breed mixes parent traits and mints the child to the owner", async () => {
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(owner.address); // 1

    const t0 = await nft.traitsOf(0);
    const t1 = await nft.traitsOf(1);

    await nft.connect(owner).breed(0, 1); // child = token 2
    expect(await nft.ownerOf(2)).to.equal(owner.address);
    expect(await nft.minted()).to.equal(3n);

    // Every nibble of the child must come from one of the two parents.
    const child = await nft.traitsOf(2);
    for (let i = 0; i < 64; i++) {
      const shift = BigInt(i * 4);
      const cn = (child >> shift) & 0xfn;
      const a = (t0 >> shift) & 0xfn;
      const b = (t1 >> shift) & 0xfn;
      expect(cn === a || cn === b).to.equal(true);
    }
  });

  it("breeding a parent on cooldown reverts, then succeeds after time passes", async () => {
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(owner.address); // 1
    await nft.mintGenesis(owner.address); // 2

    await nft.connect(owner).breed(0, 1); // arms cooldown on 0 and 1

    // Parent 0 is now on cooldown.
    expect(await nft.canBreed(0)).to.equal(false);
    await expect(nft.connect(owner).breed(0, 2)).to.be.revertedWith("p1 cooldown");

    await time.increase(24 * 60 * 60 + 1); // > 1 day

    expect(await nft.canBreed(0)).to.equal(true);
    await nft.connect(owner).breed(0, 2);
    expect(await nft.ownerOf(4)).to.equal(owner.address); // tokens: 0,1,2 genesis, 3 + 4 children
  });

  it("breeding creatures you don't own reverts", async () => {
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(other.address); // 1

    // caller `owner` does not own token 1
    await expect(nft.connect(owner).breed(0, 1)).to.be.revertedWith("not owner p2");
    // caller `other` does not own token 0
    await expect(nft.connect(other).breed(0, 1)).to.be.revertedWith("not owner p1");
  });

  it("only MINTER_ROLE can mint genesis creatures", async () => {
    await expect(nft.connect(owner).mintGenesis(owner.address)).to.be.reverted;
  });
});
