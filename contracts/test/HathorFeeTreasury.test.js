const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("HathorFeeTreasury", function () {
  let treasury, token, admin, governor, attacker, payee;

  beforeEach(async () => {
    [admin, governor, attacker, payee] = await ethers.getSigners();
    const T = await ethers.getContractFactory("HathorFeeTreasury");
    treasury = await T.deploy(admin.address, governor.address);
    const M = await ethers.getContractFactory("MockERC20");
    token = await M.deploy("Prana", "PRANA");
  });

  it("rejects zero admin/governor", async () => {
    const T = await ethers.getContractFactory("HathorFeeTreasury");
    await expect(T.deploy(ethers.ZeroAddress, governor.address)).to.be.reverted;
    await expect(T.deploy(admin.address, ethers.ZeroAddress)).to.be.reverted;
  });

  it("receives ERC-20 skims passively and reports balance", async () => {
    await token.mint(await treasury.getAddress(), 1000n);
    expect(await treasury.balanceERC20(await token.getAddress())).to.equal(1000n);
  });

  it("receives native value and emits Received", async () => {
    await expect(
      attacker.sendTransaction({ to: await treasury.getAddress(), value: 500n })
    ).to.emit(treasury, "Received");
    expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(500n);
  });

  it("ONLY governor (DAO/timelock) can withdraw ERC-20", async () => {
    await token.mint(await treasury.getAddress(), 1000n);
    await expect(
      treasury.connect(attacker).withdrawERC20(await token.getAddress(), attacker.address, 1000n)
    ).to.be.reverted;
    await expect(
      treasury.connect(admin).withdrawERC20(await token.getAddress(), payee.address, 1000n)
    ).to.be.reverted; // admin holds DEFAULT_ADMIN, not GOVERNOR_ROLE

    await treasury.connect(governor).withdrawERC20(await token.getAddress(), payee.address, 400n);
    expect(await token.balanceOf(payee.address)).to.equal(400n);
  });

  it("ONLY governor can withdraw native", async () => {
    await governor.sendTransaction({ to: await treasury.getAddress(), value: 1000n });
    await expect(
      treasury.connect(attacker).withdrawNative(attacker.address, 1000n)
    ).to.be.reverted;
    await expect(
      treasury.connect(governor).withdrawNative(payee.address, 600n)
    ).to.emit(treasury, "WithdrawnNative");
  });

  it("withdraw rejects zero recipient", async () => {
    await token.mint(await treasury.getAddress(), 100n);
    await expect(
      treasury.connect(governor).withdrawERC20(await token.getAddress(), ethers.ZeroAddress, 100n)
    ).to.be.revertedWithCustomError(treasury, "ZeroRecipient");
  });

  it("exposes NO trading surface (never trades boundary)", async () => {
    // Assert the contract has no approve/swap/trade entrypoints — only collect + governed withdraw.
    const names = treasury.interface.fragments.map((f) => f.name);
    for (const forbidden of ["approve", "swap", "trade", "buy", "sell", "addLiquidity"]) {
      expect(names).to.not.include(forbidden);
    }
  });
});
