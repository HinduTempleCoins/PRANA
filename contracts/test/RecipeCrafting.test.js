const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RecipeCrafting", function () {
  const BASE_URI = "https://prana.example/api/token/{id}.json";

  // Item ids used across tests.
  const WOOD = 1n;
  const IRON = 2n;
  const SWORD = 10n;
  const SHIELD = 11n;

  let items, crafting, admin, player, other;

  beforeEach(async function () {
    [admin, player, other] = await ethers.getSigners();

    const Items = await ethers.getContractFactory("ERC1155Base");
    items = await Items.deploy(BASE_URI, admin.address);
    await items.waitForDeployment();

    const Crafting = await ethers.getContractFactory("RecipeCrafting");
    crafting = await Crafting.deploy(await items.getAddress(), admin.address);
    await crafting.waitForDeployment();

    // Grant the crafting contract MINTER_ROLE so it can mint outputs.
    const MINTER_ROLE = await items.MINTER_ROLE();
    await items
      .connect(admin)
      .grantRole(MINTER_ROLE, await crafting.getAddress());

    // Player approves the crafting contract to burn their items.
    await items
      .connect(player)
      .setApprovalForAll(await crafting.getAddress(), true);
  });

  it("registers a recipe and exposes it via getRecipe", async function () {
    await expect(
      crafting.connect(admin).addRecipe([WOOD], [3n], SWORD, 1n)
    )
      .to.emit(crafting, "RecipeAdded")
      .withArgs(0n, [WOOD], [3n], SWORD, 1n);

    expect(await crafting.recipeCount()).to.equal(1n);

    const r = await crafting.getRecipe(0n);
    expect(r.inputIds).to.deep.equal([WOOD]);
    expect(r.inputAmounts).to.deep.equal([3n]);
    expect(r.outputId).to.equal(SWORD);
    expect(r.outputAmount).to.equal(1n);
  });

  it("craft burns inputs from the player and mints the output", async function () {
    await crafting.connect(admin).addRecipe([WOOD], [3n], SWORD, 2n);
    await items.connect(admin).mint(player.address, WOOD, 5n, "0x");

    await expect(crafting.connect(player).craft(0n))
      .to.emit(crafting, "Crafted")
      .withArgs(0n, player.address);

    // 5 wood - 3 burned = 2 left.
    expect(await items.balanceOf(player.address, WOOD)).to.equal(2n);
    // Output minted.
    expect(await items.balanceOf(player.address, SWORD)).to.equal(2n);
  });

  it("reverts when the player lacks enough input items", async function () {
    await crafting.connect(admin).addRecipe([WOOD], [3n], SWORD, 1n);
    await items.connect(admin).mint(player.address, WOOD, 2n, "0x"); // not enough

    await expect(crafting.connect(player).craft(0n)).to.be.revertedWithCustomError(
      items,
      "ERC1155InsufficientBalance"
    );

    // Nothing minted on the failed craft.
    expect(await items.balanceOf(player.address, SWORD)).to.equal(0n);
  });

  it("supports a multi-input recipe (recipe web)", async function () {
    await crafting.connect(admin).addRecipe([WOOD, IRON], [2n, 4n], SHIELD, 1n);
    await items.connect(admin).mint(player.address, WOOD, 2n, "0x");
    await items.connect(admin).mint(player.address, IRON, 10n, "0x");

    await crafting.connect(player).craft(0n);

    expect(await items.balanceOf(player.address, WOOD)).to.equal(0n);
    expect(await items.balanceOf(player.address, IRON)).to.equal(6n);
    expect(await items.balanceOf(player.address, SHIELD)).to.equal(1n);
  });

  it("reverts on an unknown recipe id", async function () {
    await expect(crafting.connect(player).craft(99n))
      .to.be.revertedWithCustomError(crafting, "UnknownRecipe")
      .withArgs(99n);
  });

  it("only an ADMIN_ROLE account can register recipes", async function () {
    const ADMIN_ROLE = await crafting.ADMIN_ROLE();
    await expect(
      crafting.connect(other).addRecipe([WOOD], [1n], SWORD, 1n)
    )
      .to.be.revertedWithCustomError(crafting, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), ADMIN_ROLE);
  });
});
