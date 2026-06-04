const { expect } = require("chai");
const { ethers } = require("hardhat");

const WAD = 10n ** 18n;

describe("ERC4626Vault (tokenized vault)", function () {
  let asset, vault, alice, bob;

  beforeEach(async () => {
    [, alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    asset = await Mock.deploy("Underlying", "UND");

    const Vault = await ethers.getContractFactory("ERC4626Vault");
    vault = await Vault.deploy(await asset.getAddress(), "Vault Share", "vUND");

    // Fund and approve both depositors.
    for (const who of [alice, bob]) {
      await asset.mint(who.address, 1000n * WAD);
      await asset.connect(who).approve(await vault.getAddress(), ethers.MaxUint256);
    }
  });

  it("mints shares 1:1 on an empty vault and tracks totalAssets", async () => {
    await vault.connect(alice).deposit(100n * WAD, alice.address);

    expect(await vault.balanceOf(alice.address)).to.equal(100n * WAD); // 1:1
    expect(await vault.totalSupply()).to.equal(100n * WAD);
    expect(await vault.totalAssets()).to.equal(100n * WAD); // tracks held balance
    expect(await asset.balanceOf(await vault.getAddress())).to.equal(100n * WAD);
  });

  it("withdraw and redeem return the underlying assets", async () => {
    await vault.connect(alice).deposit(100n * WAD, alice.address);

    // Withdraw burns shares and returns assets.
    await vault.connect(alice).withdraw(40n * WAD, alice.address, alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(60n * WAD);

    // Redeem the remaining shares for assets.
    const before = await asset.balanceOf(alice.address);
    await vault.connect(alice).redeem(60n * WAD, alice.address, alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
    expect(await asset.balanceOf(alice.address)).to.equal(before + 60n * WAD);
    expect(await vault.totalAssets()).to.equal(0n);
  });

  it("convertToShares / convertToAssets are 1:1 on a fresh vault", async () => {
    expect(await vault.convertToShares(123n * WAD)).to.equal(123n * WAD);
    expect(await vault.convertToAssets(123n * WAD)).to.equal(123n * WAD);

    await vault.connect(alice).deposit(100n * WAD, alice.address);
    // Still 1:1 with no yield: round-trips back to itself.
    expect(await vault.convertToAssets(await vault.convertToShares(50n * WAD)))
      .to.equal(50n * WAD);
  });

  it("a second depositor after a direct donation gets fewer shares (price > 1)", async () => {
    await vault.connect(alice).deposit(100n * WAD, alice.address); // 100 shares @ 1:1

    // Direct asset donation pushes totalAssets above totalSupply -> share price > 1.
    await asset.connect(alice).transfer(await vault.getAddress(), 100n * WAD);
    expect(await vault.totalAssets()).to.equal(200n * WAD);
    expect(await vault.totalSupply()).to.equal(100n * WAD);

    // Bob deposits the same 100 assets but now each share costs ~2 assets,
    // so he receives strictly fewer shares than assets supplied.
    await vault.connect(bob).deposit(100n * WAD, bob.address);
    const bobShares = await vault.balanceOf(bob.address);
    expect(bobShares).to.be.lessThan(100n * WAD);
    expect(bobShares).to.equal(await vault.previewDeposit(100n * WAD));
  });

  it("reverts when redeeming more shares than owned", async () => {
    await vault.connect(alice).deposit(100n * WAD, alice.address);
    await expect(
      vault.connect(alice).redeem(101n * WAD, alice.address, alice.address)
    ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxRedeem");
  });
});
