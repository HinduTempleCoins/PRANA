const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("CreatureBreeding (commit-reveal gene-mix breeder)", function () {
  const BREED_FEE = ethers.parseEther("5");
  const COOLDOWN_BLOCKS = 10n;

  async function deployFixture() {
    const [admin, owner, other] = await ethers.getSigners();

    const NFT = await ethers.getContractFactory("CreatureNFT");
    const nft = await NFT.deploy(admin.address);
    await nft.waitForDeployment();

    const Fee = await ethers.getContractFactory("MockERC20");
    const fee = await Fee.deploy("Breed Fee", "BREED");
    await fee.waitForDeployment();

    const Breeding = await ethers.getContractFactory("CreatureBreeding");
    const breeding = await Breeding.deploy(
      await nft.getAddress(),
      await fee.getAddress(),
      BREED_FEE,
      COOLDOWN_BLOCKS,
      admin.address
    );
    await breeding.waitForDeployment();

    // Breeder must hold MINTER_ROLE on the collection to mint children.
    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).grantRole(MINTER_ROLE, await breeding.getAddress());

    // Fund + approve `owner` to pay (and have burned) the breed fee.
    await fee.mint(owner.address, ethers.parseEther("1000"));
    await fee
      .connect(owner)
      .approve(await breeding.getAddress(), ethers.MaxUint256);

    return { nft, fee, breeding, admin, owner, other };
  }

  // Mint two genesis creatures to `owner` (tokens 0 and 1).
  async function mintTwoParents(nft, owner) {
    await nft.mintGenesis(owner.address); // token 0
    await nft.mintGenesis(owner.address); // token 1
  }

  it("happy path: commit burns the fee, reveal gene-mixes parents into a child", async function () {
    const { nft, fee, breeding, owner } = await loadFixture(deployFixture);
    await mintTwoParents(nft, owner);

    const t0 = await nft.traitsOf(0);
    const t1 = await nft.traitsOf(1);
    const supplyBefore = await fee.totalSupply();

    await expect(breeding.connect(owner).commitBreed(0, 1))
      .to.emit(breeding, "BreedCommitted");

    // Fee was burned (supply dropped), not just transferred.
    expect(await fee.totalSupply()).to.equal(supplyBefore - BREED_FEE);

    await mine(2); // advance past commitBlock+1

    await expect(breeding.connect(owner).revealBreed())
      .to.emit(breeding, "BreedRevealed");

    // Child is token 2, owned by the breeder.
    expect(await nft.ownerOf(2)).to.equal(owner.address);

    // Every nibble of the recorded child traits comes from one of the two parents.
    const child = await breeding.childTraits(2);
    for (let i = 0; i < 64; i++) {
      const shift = BigInt(i * 4);
      const cn = (child >> shift) & 0xfn;
      const a = (t0 >> shift) & 0xfn;
      const b = (t1 >> shift) & 0xfn;
      expect(cn === a || cn === b).to.equal(true);
    }

    // Commit cleared.
    const c = await breeding.commitments(owner.address);
    expect(c.open).to.equal(false);
  });

  it("fee burn reduces total supply by exactly the breed fee", async function () {
    const { nft, fee, breeding, owner } = await loadFixture(deployFixture);
    await mintTwoParents(nft, owner);

    const before = await fee.totalSupply();
    await breeding.connect(owner).commitBreed(0, 1);
    expect(before - (await fee.totalSupply())).to.equal(BREED_FEE);
  });

  it("reveal in the commit/next block reverts TooEarly", async function () {
    const { nft, breeding, owner } = await loadFixture(deployFixture);
    await mintTwoParents(nft, owner);

    await breeding.connect(owner).commitBreed(0, 1);
    await expect(
      breeding.connect(owner).revealBreed()
    ).to.be.revertedWithCustomError(breeding, "TooEarly");
  });

  it("enforces a per-parent cooldown across breeds", async function () {
    const { nft, breeding, owner } = await loadFixture(deployFixture);
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(owner.address); // 1
    await nft.mintGenesis(owner.address); // 2

    // First breed of 0 + 1 (mints child token 3).
    await breeding.connect(owner).commitBreed(0, 1);
    await mine(2);
    await breeding.connect(owner).revealBreed();

    // Parent 0 is on cooldown.
    expect(await breeding.canBreed(0)).to.equal(false);
    await expect(breeding.connect(owner).commitBreed(0, 2))
      .to.be.revertedWithCustomError(breeding, "ParentOnCooldown")
      .withArgs(0n);

    // After the cooldown window, parent 0 can breed again.
    await mine(COOLDOWN_BLOCKS);
    expect(await breeding.canBreed(0)).to.equal(true);
    await breeding.connect(owner).commitBreed(0, 2);
    await mine(2);
    await breeding.connect(owner).revealBreed();
    // Tokens: 0,1,2 genesis; 3 + 4 children.
    expect(await nft.ownerOf(4)).to.equal(owner.address);
  });

  it("rejects breeding a token id the caller does not own", async function () {
    const { nft, breeding, owner, other } = await loadFixture(deployFixture);
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(other.address); // 1

    await expect(breeding.connect(owner).commitBreed(0, 1))
      .to.be.revertedWithCustomError(breeding, "NotParentOwner")
      .withArgs(1n);
  });

  it("rejects breeding a creature with itself", async function () {
    const { nft, breeding, owner } = await loadFixture(deployFixture);
    await mintTwoParents(nft, owner);
    await expect(
      breeding.connect(owner).commitBreed(0, 0)
    ).to.be.revertedWithCustomError(breeding, "SameParent");
  });

  it("only one open commit per breeder at a time", async function () {
    const { nft, breeding, owner } = await loadFixture(deployFixture);
    await nft.mintGenesis(owner.address); // 0
    await nft.mintGenesis(owner.address); // 1
    await nft.mintGenesis(owner.address); // 2
    await nft.mintGenesis(owner.address); // 3

    await breeding.connect(owner).commitBreed(0, 1);
    await expect(
      breeding.connect(owner).commitBreed(2, 3)
    ).to.be.revertedWithCustomError(breeding, "CommitOpen");
  });

  it("reveal without a commit reverts NoCommit", async function () {
    const { breeding, owner } = await loadFixture(deployFixture);
    await expect(
      breeding.connect(owner).revealBreed()
    ).to.be.revertedWithCustomError(breeding, "NoCommit");
  });

  it("commit fails without fee approval/balance", async function () {
    const { nft, fee, breeding, owner, other } = await loadFixture(deployFixture);
    // `other` owns parents but never approved/funded the fee token.
    await nft.mintGenesis(other.address); // 0
    await nft.mintGenesis(other.address); // 1
    await expect(breeding.connect(other).commitBreed(0, 1)).to.be.reverted;
  });

  it("breeder must hold MINTER_ROLE on the collection to mint children", async function () {
    const { nft, breeding, owner, admin } = await loadFixture(deployFixture);
    await mintTwoParents(nft, owner);

    // Revoke the breeder's mint role; reveal can no longer mint the child.
    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).revokeRole(MINTER_ROLE, await breeding.getAddress());

    await breeding.connect(owner).commitBreed(0, 1);
    await mine(2);
    await expect(breeding.connect(owner).revealBreed()).to.be.reverted;
  });
});
