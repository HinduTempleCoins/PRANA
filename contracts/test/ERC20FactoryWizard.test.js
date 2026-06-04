const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ERC20FactoryWizard", function () {
  let wiz, admin, creator;

  beforeEach(async () => {
    [admin, creator] = await ethers.getSigners();
    const W = await ethers.getContractFactory("ERC20FactoryWizard");
    wiz = await W.deploy();
  });

  it("deploys an owned token, mints initial supply, and hands over all roles", async () => {
    const CAP = 10n ** 24n;
    await wiz.connect(creator).createToken("Foo", "FOO", CAP, 1000n, creator.address);
    expect(await wiz.tokenCount()).to.equal(1n);

    const addr = await wiz.allTokens(0);
    const t = await ethers.getContractAt("ERC20Base", addr);
    expect(await t.name()).to.equal("Foo");
    expect(await t.cap()).to.equal(CAP);
    expect(await t.balanceOf(creator.address)).to.equal(1000n);

    const MINTER = await t.MINTER_ROLE();
    const ADMIN = await t.DEFAULT_ADMIN_ROLE();
    // creator controls it; the factory holds nothing (no backdoor)
    expect(await t.hasRole(MINTER, creator.address)).to.equal(true);
    expect(await t.hasRole(ADMIN, creator.address)).to.equal(true);
    expect(await t.hasRole(MINTER, await wiz.getAddress())).to.equal(false);
    expect(await t.hasRole(ADMIN, await wiz.getAddress())).to.equal(false);
  });
});
