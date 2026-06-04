const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ERC-20 transfer(address,uint256) selector — used as an allowlisted, metered outflow path.
const TRANSFER_SEL = ethers.id("transfer(address,uint256)").slice(0, 10);

describe("KeeperGatedVault", function () {
  const UNPAUSE_DELAY = 3600;
  const EPOCH = 1000; // seconds
  const MAX_SINGLE = 500n;
  const EPOCH_CAP = 800n;
  const VAULT_FUNDS = 10_000n;

  const ERC20_IFACE = new ethers.Interface(["function transfer(address,uint256)"]);

  // encode an ERC-20 transfer(to, amount) calldata
  function encodeTransfer(to, amount) {
    return ERC20_IFACE.encodeFunctionData("transfer", [to, amount]);
  }

  const deployLive = () => deployFixture(false);
  const deployPaper = () => deployFixture(true);

  async function deployFixture(paper = false) {
    const [owner, keeper, sink, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Asset", "AST");

    const Mock2 = await ethers.getContractFactory("SpendTargetMock");
    const targetMock = await Mock2.deploy();

    const Vault = await ethers.getContractFactory("KeeperGatedVault");
    const vault = await Vault.deploy(owner.address, keeper.address, UNPAUSE_DELAY, EPOCH, paper);

    await token.mint(await vault.getAddress(), VAULT_FUNDS);

    const tokenAddr = await token.getAddress();
    // Allowlist the token's own transfer selector (metered outflow path).
    await vault.connect(owner).setAllowed(tokenAddr, TRANSFER_SEL, true);
    await vault.connect(owner).setMaxSingleSpend(tokenAddr, MAX_SINGLE);
    await vault.connect(owner).setEpochCap(tokenAddr, EPOCH_CAP);

    return { owner, keeper, sink, other, token, tokenAddr, targetMock, vault };
  }

  it("constructor wires roles, keeper, paper-trade flag", async () => {
    const { vault, owner, keeper } = await loadFixture(deployLive);
    expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
    expect(await vault.hasRole(await vault.KEEPER_ROLE(), keeper.address)).to.equal(true);
    expect(await vault.paperTrade()).to.equal(false);
  });

  it("keeper can execute an allowlisted transfer and outflow is metered", async () => {
    const { vault, keeper, token, tokenAddr, sink } = await loadFixture(deployLive);
    const data = encodeTransfer(sink.address, 400n);

    await expect(vault.connect(keeper).execute(tokenAddr, data, 0, [tokenAddr]))
      .to.emit(vault, "Outflow")
      .withArgs(tokenAddr, 400n, await vault.currentEpoch(), 400n)
      .and.to.emit(vault, "Executed");

    expect(await token.balanceOf(sink.address)).to.equal(400n);
    expect(await vault.remainingEpochBudget(tokenAddr)).to.equal(EPOCH_CAP - 400n);
  });

  it("reverts a non-allowlisted (target, selector)", async () => {
    const { vault, keeper, targetMock } = await loadFixture(deployLive);
    const data = new ethers.Interface(["function doThing(uint256)"]).encodeFunctionData(
      "doThing",
      [1]
    );
    await expect(
      vault.connect(keeper).execute(await targetMock.getAddress(), data, 0, [])
    ).to.be.revertedWithCustomError(vault, "NotAllowed");
  });

  it("reverts when single-tx outflow exceeds maxSingleSpend (balance-delta)", async () => {
    const { vault, keeper, tokenAddr, sink } = await loadFixture(deployLive);
    const data = encodeTransfer(sink.address, MAX_SINGLE + 1n);
    await expect(
      vault.connect(keeper).execute(tokenAddr, data, 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "SingleSpendExceeded");
  });

  it("reverts when cumulative epoch outflow exceeds epochCap", async () => {
    const { vault, keeper, tokenAddr, sink } = await loadFixture(deployLive);
    // 500 + 500 = 1000 > 800 cap (each within single cap of 500).
    await vault.connect(keeper).execute(tokenAddr, encodeTransfer(sink.address, 500n), 0, [tokenAddr]);
    await expect(
      vault.connect(keeper).execute(tokenAddr, encodeTransfer(sink.address, 500n), 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "EpochCapExceeded");

    // next epoch -> budget resets
    await time.increase(EPOCH);
    await expect(
      vault.connect(keeper).execute(tokenAddr, encodeTransfer(sink.address, 500n), 0, [tokenAddr])
    ).to.emit(vault, "Outflow");
  });

  it("paper-trade mode emits ProposedAction and performs NO external call", async () => {
    const { owner, keeper, targetMock, vault } = await loadFixture(deployPaper);
    const tAddr = await targetMock.getAddress();
    const sel = new ethers.Interface(["function doThing(uint256)"])
      .getFunction("doThing")
      .selector;
    await vault.connect(owner).setAllowed(tAddr, sel, true);

    const data = new ethers.Interface(["function doThing(uint256)"]).encodeFunctionData(
      "doThing",
      [99]
    );

    await expect(vault.connect(keeper).execute(tAddr, data, 0, []))
      .to.emit(vault, "ProposedAction")
      .withArgs(keeper.address, tAddr, sel, data, 0);

    // the target was never actually called
    expect(await targetMock.calls()).to.equal(0n);
  });

  it("non-keeper cannot execute", async () => {
    const { vault, other, tokenAddr, sink } = await loadFixture(deployLive);
    await expect(
      vault.connect(other).execute(tokenAddr, encodeTransfer(sink.address, 1n), 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("pause blocks execution; guarded unpause restores it", async () => {
    const { vault, owner, keeper, tokenAddr, sink } = await loadFixture(deployLive);
    await vault.connect(owner).pause();
    await expect(
      vault.connect(keeper).execute(tokenAddr, encodeTransfer(sink.address, 1n), 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "EnforcedPause");

    await vault.connect(owner).proposeUnpause();
    await time.increase(UNPAUSE_DELAY);
    await vault.connect(owner).executeUnpause();

    await expect(
      vault.connect(keeper).execute(tokenAddr, encodeTransfer(sink.address, 100n), 0, [tokenAddr])
    ).to.emit(vault, "Executed");
  });

  it("reverts when the underlying call fails", async () => {
    const { vault, owner, keeper, tokenAddr } = await loadFixture(deployLive);
    // transfer more than the vault holds -> ERC20 revert bubbles as CallFailed
    const data = encodeTransfer(owner.address, VAULT_FUNDS + 1n);
    // single cap would block first if smaller; raise caps so the call itself is what fails.
    await vault.connect(owner).setMaxSingleSpend(tokenAddr, VAULT_FUNDS + 10n);
    await vault.connect(owner).setEpochCap(tokenAddr, VAULT_FUNDS + 10n);
    await expect(
      vault.connect(keeper).execute(tokenAddr, data, 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "CallFailed");
  });

  it("only owner can configure rails", async () => {
    const { vault, other, tokenAddr } = await loadFixture(deployLive);
    await expect(
      vault.connect(other).setAllowed(tokenAddr, TRANSFER_SEL, true)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await expect(vault.connect(other).setPaperTrade(true)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("owner can add/remove keepers", async () => {
    const { vault, owner, other, tokenAddr, sink } = await loadFixture(deployLive);
    await vault.connect(owner).setKeeper(other.address, true);
    await expect(
      vault.connect(other).execute(tokenAddr, encodeTransfer(sink.address, 10n), 0, [tokenAddr])
    ).to.emit(vault, "Executed");

    await vault.connect(owner).setKeeper(other.address, false);
    await expect(
      vault.connect(other).execute(tokenAddr, encodeTransfer(sink.address, 10n), 0, [tokenAddr])
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });
});
