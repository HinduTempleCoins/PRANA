const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BASE_URI = "https://prana.example/item/{id}.json";

// Category enum mirror.
const Cat = { Invalid: 0n, Seed: 1n, Resource: 2n, Consumable: 3n, Cosmetic: 4n };

describe("ItemRegistry", function () {
  async function deployFixture() {
    const [admin, holder, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ItemRegistry");
    const reg = await Factory.deploy(BASE_URI, admin.address);
    await reg.waitForDeployment();
    return { reg, admin, holder, other };
  }

  it("grants all minter roles + uri setter to admin", async function () {
    const { reg, admin } = await loadFixture(deployFixture);
    for (const role of [
      "SEED_MINTER_ROLE",
      "RESOURCE_MINTER_ROLE",
      "CONSUMABLE_MINTER_ROLE",
      "COSMETIC_MINTER_ROLE",
      "URI_SETTER_ROLE",
    ]) {
      const r = await reg[role]();
      expect(await reg.hasRole(r, admin.address)).to.equal(true);
    }
  });

  it("classifies ids by range", async function () {
    const { reg } = await loadFixture(deployFixture);
    expect(await reg.categoryOf(0)).to.equal(Cat.Invalid);
    expect(await reg.categoryOf(1)).to.equal(Cat.Seed);
    expect(await reg.categoryOf(9999)).to.equal(Cat.Seed);
    expect(await reg.categoryOf(10000)).to.equal(Cat.Resource);
    expect(await reg.categoryOf(19999)).to.equal(Cat.Resource);
    expect(await reg.categoryOf(20000)).to.equal(Cat.Consumable);
    expect(await reg.categoryOf(29999)).to.equal(Cat.Consumable);
    expect(await reg.categoryOf(30000)).to.equal(Cat.Cosmetic);
    expect(await reg.categoryOf(10n ** 9n)).to.equal(Cat.Cosmetic);
  });

  it("mints a seed in range and tracks supply", async function () {
    const { reg, admin, holder } = await loadFixture(deployFixture);
    await expect(reg.mintSeed(holder.address, 5n, 100n, "0x"))
      .to.emit(reg, "ItemMinted")
      .withArgs(holder.address, 5n, 100n, Cat.Seed);
    expect(await reg.balanceOf(holder.address, 5n)).to.equal(100n);
    expect(await reg["totalSupply(uint256)"](5n)).to.equal(100n);
    expect(await reg.exists(5n)).to.equal(true);
  });

  it("rejects seed mint with an out-of-range id", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    await expect(reg.mintSeed(holder.address, 10000n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "WrongRange")
      .withArgs(10000n, Cat.Seed);
    await expect(reg.mintSeed(holder.address, 0n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "WrongRange")
      .withArgs(0n, Cat.Seed);
  });

  it("each range mint enforces its own range", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    await reg.mintResource(holder.address, 15000n, 3n, "0x");
    await reg.mintConsumable(holder.address, 25000n, 4n, "0x");
    await reg.mintCosmetic(holder.address, 99999n, 2n, "0x");
    expect(await reg.balanceOf(holder.address, 15000n)).to.equal(3n);
    expect(await reg.balanceOf(holder.address, 25000n)).to.equal(4n);
    expect(await reg.balanceOf(holder.address, 99999n)).to.equal(2n);

    await expect(reg.mintResource(holder.address, 5n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "WrongRange")
      .withArgs(5n, Cat.Resource);
    await expect(reg.mintCosmetic(holder.address, 25000n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "WrongRange")
      .withArgs(25000n, Cat.Cosmetic);
  });

  it("enforces per-range minter roles", async function () {
    const { reg, other, holder } = await loadFixture(deployFixture);
    const SEED_MINTER_ROLE = await reg.SEED_MINTER_ROLE();
    await expect(reg.connect(other).mintSeed(holder.address, 1n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), SEED_MINTER_ROLE);
  });

  it("a seed minter cannot mint cosmetics", async function () {
    const { reg, admin, other, holder } = await loadFixture(deployFixture);
    const SEED_MINTER_ROLE = await reg.SEED_MINTER_ROLE();
    const COSMETIC_MINTER_ROLE = await reg.COSMETIC_MINTER_ROLE();
    await reg.connect(admin).grantRole(SEED_MINTER_ROLE, other.address);

    await reg.connect(other).mintSeed(holder.address, 7n, 1n, "0x"); // allowed
    await expect(reg.connect(other).mintCosmetic(holder.address, 30000n, 1n, "0x"))
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), COSMETIC_MINTER_ROLE);
  });

  it("batch-mints across ranges when admin holds all roles", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    const ids = [5n, 15000n, 25000n, 30000n];
    const amounts = [1n, 2n, 3n, 4n];
    await reg.mintBatch(holder.address, ids, amounts, "0x");
    const bals = await reg.balanceOfBatch(
      ids.map(() => holder.address),
      ids
    );
    expect(bals).to.deep.equal(amounts);
  });

  it("batch-mint rejects invalid id 0", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    await expect(reg.mintBatch(holder.address, [0n], [1n], "0x"))
      .to.be.revertedWithCustomError(reg, "InvalidId")
      .withArgs(0n);
  });

  it("batch-mint rejects length mismatch", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    await expect(
      reg.mintBatch(holder.address, [5n, 6n], [1n], "0x")
    ).to.be.revertedWithCustomError(reg, "LengthMismatch");
  });

  it("batch-mint enforces roles per id", async function () {
    const { reg, admin, other, holder } = await loadFixture(deployFixture);
    const SEED_MINTER_ROLE = await reg.SEED_MINTER_ROLE();
    const RESOURCE_MINTER_ROLE = await reg.RESOURCE_MINTER_ROLE();
    await reg.connect(admin).grantRole(SEED_MINTER_ROLE, other.address);
    // other has seed but not resource role -> mixed batch reverts on the resource id
    await expect(
      reg.connect(other).mintBatch(holder.address, [5n, 15000n], [1n, 1n], "0x")
    )
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), RESOURCE_MINTER_ROLE);
  });

  it("uri returns the base URI; URI_SETTER can update it", async function () {
    const { reg, admin, other } = await loadFixture(deployFixture);
    expect(await reg.uri(5n)).to.equal(BASE_URI);
    const NEW = "ipfs://cid/{id}.json";
    await expect(reg.connect(admin).setURI(NEW))
      .to.emit(reg, "BaseURIUpdated")
      .withArgs(NEW);
    expect(await reg.uri(5n)).to.equal(NEW);

    const URI_SETTER_ROLE = await reg.URI_SETTER_ROLE();
    await expect(reg.connect(other).setURI("x"))
      .to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), URI_SETTER_ROLE);
  });

  it("burning reduces tracked supply", async function () {
    const { reg, holder } = await loadFixture(deployFixture);
    await reg.mintSeed(holder.address, 5n, 10n, "0x");
    await reg.connect(holder).burn(holder.address, 5n, 4n);
    expect(await reg["totalSupply(uint256)"](5n)).to.equal(6n);
  });

  it("supportsInterface for ERC1155 + AccessControl", async function () {
    const { reg } = await loadFixture(deployFixture);
    expect(await reg.supportsInterface("0xd9b67a26")).to.equal(true); // ERC1155
    expect(await reg.supportsInterface("0x7965db0b")).to.equal(true); // IAccessControl
    expect(await reg.supportsInterface("0xffffffff")).to.equal(false);
  });
});
