const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Build a FacetCut tuple array for diamondCut(...).
const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

// Collect every external/public selector of a deployed facet, excluding inherited noise.
function selectorsOf(contract, names) {
  return names.map((n) => contract.interface.getFunction(n).selector);
}

describe("Diamond (ERC-2535 skeleton)", function () {
  async function deployDiamondFixture() {
    const [owner, stranger] = await ethers.getSigners();

    const CutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const cutFacet = await CutFacet.deploy();
    await cutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(owner.address, await cutFacet.getAddress());
    await diamond.waitForDeployment();

    const LoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    const loupeFacet = await LoupeFacet.deploy();
    await loupeFacet.waitForDeployment();

    const BurnMineFacet = await ethers.getContractFactory("BurnMineFacet");
    const burnFacet = await BurnMineFacet.deploy();
    await burnFacet.waitForDeployment();

    // Interfaces "as" the diamond address for each facet's calls.
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress());

    return { owner, stranger, diamond, cutFacet, loupeFacet, burnFacet, cut, loupe };
  }

  it("reverts on an unrouted selector via the fallback", async function () {
    const { diamond } = await loadFixture(deployDiamondFixture);
    // No loupe facet added yet: any non-diamondCut selector is unrouted.
    const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress());
    const diamondAsErr = await ethers.getContractAt("Diamond", await diamond.getAddress());
    await expect(loupe.facetAddresses()).to.be.revertedWithCustomError(
      diamondAsErr,
      "FunctionNotFound"
    );
  });

  it("adds the loupe facet and reports facets/selectors", async function () {
    const { diamond, owner, cutFacet, loupeFacet } = await loadFixture(deployDiamondFixture);
    const loupeSelectors = selectorsOf(loupeFacet, [
      "facets",
      "facetFunctionSelectors",
      "facetAddresses",
      "facetAddress",
      "supportsInterface",
    ]);
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: await loupeFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: loupeSelectors,
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress());
    const addresses = await loupe.facetAddresses();
    expect(addresses).to.include(await cutFacet.getAddress());
    expect(addresses).to.include(await loupeFacet.getAddress());

    // facetAddress(selector) resolves the diamondCut selector to the cut facet.
    const cutSel = cutFacet.interface.getFunction("diamondCut").selector;
    expect(await loupe.facetAddress(cutSel)).to.equal(await cutFacet.getAddress());

    // The loupe facet reports its own selectors.
    const reported = await loupe.facetFunctionSelectors(await loupeFacet.getAddress());
    expect([...reported].sort()).to.deep.equal([...loupeSelectors].sort());
  });

  it("dispatches a demo facet through the fallback and shares storage", async function () {
    const { diamond, owner, loupeFacet, burnFacet } = await loadFixture(deployDiamondFixture);
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());

    const loupeSelectors = selectorsOf(loupeFacet, [
      "facets",
      "facetFunctionSelectors",
      "facetAddresses",
      "facetAddress",
      "supportsInterface",
    ]);
    const burnSelectors = selectorsOf(burnFacet, [
      "configureMine",
      "mine",
      "mintedOf",
      "totalBurned",
      "totalMinted",
    ]);

    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: await loupeFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: loupeSelectors,
        },
        {
          facetAddress: await burnFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: burnSelectors,
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    // Call the burn-mine facet THROUGH the diamond address.
    const mine = await ethers.getContractAt("BurnMineFacet", await diamond.getAddress());
    await mine.connect(owner).configureMine(1, 10); // 10 in -> 1 out
    await expect(mine.connect(owner).mine(1000))
      .to.emit(mine, "Mined")
      .withArgs(owner.address, 1000, 100);

    expect(await mine.totalBurned()).to.equal(1000);
    expect(await mine.totalMinted()).to.equal(100);
    expect(await mine.mintedOf(owner.address)).to.equal(100);
  });

  it("replaces a selector and routes to the new facet", async function () {
    const { diamond, owner, loupeFacet } = await loadFixture(deployDiamondFixture);
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    const loupe = await ethers.getContractAt("IDiamondLoupe", await diamond.getAddress());

    const loupeSelectors = selectorsOf(loupeFacet, [
      "facets",
      "facetFunctionSelectors",
      "facetAddresses",
      "facetAddress",
      "supportsInterface",
    ]);
    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: await loupeFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: loupeSelectors,
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    // Deploy a second loupe facet and replace one selector onto it.
    const Loupe2 = await ethers.getContractFactory("DiamondLoupeFacet");
    const loupe2 = await Loupe2.deploy();
    await loupe2.waitForDeployment();
    const facetAddressSel = loupeFacet.interface.getFunction("facetAddress").selector;

    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: await loupe2.getAddress(),
          action: FacetCutAction.Replace,
          functionSelectors: [facetAddressSel],
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    expect(await loupe.facetAddress(facetAddressSel)).to.equal(await loupe2.getAddress());
  });

  it("removes a selector so the fallback reverts FunctionNotFound", async function () {
    const { diamond, owner, loupeFacet, burnFacet } = await loadFixture(deployDiamondFixture);
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());

    const loupeSelectors = selectorsOf(loupeFacet, [
      "facets",
      "facetFunctionSelectors",
      "facetAddresses",
      "facetAddress",
      "supportsInterface",
    ]);
    const burnSelectors = selectorsOf(burnFacet, [
      "configureMine",
      "mine",
      "mintedOf",
      "totalBurned",
      "totalMinted",
    ]);
    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: await loupeFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: loupeSelectors,
        },
        {
          facetAddress: await burnFacet.getAddress(),
          action: FacetCutAction.Add,
          functionSelectors: burnSelectors,
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    const mineSel = burnFacet.interface.getFunction("mine").selector;
    await cut.connect(owner).diamondCut(
      [
        {
          facetAddress: ethers.ZeroAddress,
          action: FacetCutAction.Remove,
          functionSelectors: [mineSel],
        },
      ],
      ethers.ZeroAddress,
      "0x"
    );

    const mine = await ethers.getContractAt("BurnMineFacet", await diamond.getAddress());
    const diamondAsErr = await ethers.getContractAt("Diamond", await diamond.getAddress());
    await expect(mine.mine(1)).to.be.revertedWithCustomError(
      diamondAsErr,
      "FunctionNotFound"
    );
  });

  it("reverts cut from a non-owner", async function () {
    const { diamond, stranger, cutFacet, loupeFacet } = await loadFixture(deployDiamondFixture);
    const cut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    const loupeSelectors = selectorsOf(loupeFacet, ["facetAddresses"]);

    // LibDiamond's NotContractOwner error (compiled into the cut facet) bubbles up.
    await expect(
      cut.connect(stranger).diamondCut(
        [
          {
            facetAddress: await loupeFacet.getAddress(),
            action: FacetCutAction.Add,
            functionSelectors: loupeSelectors,
          },
        ],
        ethers.ZeroAddress,
        "0x"
      )
    ).to.be.revertedWithCustomError(cutFacet, "NotContractOwner");
  });
});
