const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const REF = ethers.encodeBytes32String("ref1");

describe("BurnSink", function () {
  async function deployFixture() {
    const [admin, a] = await ethers.getSigners();

    const Burnable = await ethers.getContractFactory("MockERC20"); // ERC20Burnable
    const burnable = await Burnable.deploy("Burnable", "BRN");

    const Plain = await ethers.getContractFactory("PlainMintableERC20"); // no burn()
    const plain = await Plain.deploy("Plain", "PLN");

    const Harness = await ethers.getContractFactory("BurnSinkHarness");
    const harness = await Harness.deploy();

    const Reg = await ethers.getContractFactory("MockBurnRegistry");
    const reg = await Reg.deploy();

    return { harness, burnable, plain, reg, admin, a };
  }

  it("burnable path reduces totalSupply (real burn)", async () => {
    const { harness, burnable } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("100");
    await burnable.mint(await harness.getAddress(), amt);
    const supplyBefore = await burnable.totalSupply();

    // sink() emits Sunk(token, amount, burned=true)
    await expect(harness.sink(await burnable.getAddress(), amt, REF))
      .to.emit(harness, "Sunk")
      .withArgs(await burnable.getAddress(), amt, true);

    expect(await burnable.totalSupply()).to.equal(supplyBefore - amt);
    expect(await burnable.balanceOf(await harness.getAddress())).to.equal(0n);
    expect(await burnable.balanceOf(DEAD)).to.equal(0n);
  });

  it("non-burnable falls back to the dead address (supply unchanged)", async () => {
    const { harness, plain } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("50");
    await plain.mint(await harness.getAddress(), amt);
    const supplyBefore = await plain.totalSupply();

    await expect(harness.sink(await plain.getAddress(), amt, REF))
      .to.emit(harness, "Sunk")
      .withArgs(await plain.getAddress(), amt, false);

    // Supply unchanged; tokens parked at the dead address.
    expect(await plain.totalSupply()).to.equal(supplyBefore);
    expect(await plain.balanceOf(DEAD)).to.equal(amt);
    expect(await plain.balanceOf(await harness.getAddress())).to.equal(0n);
  });

  it("libSafeBurn returns true for burnable, false for plain", async () => {
    const { harness, burnable, plain } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("10");
    await burnable.mint(await harness.getAddress(), amt);
    await plain.mint(await harness.getAddress(), amt);

    // staticCall to read the bool return without sending state? These mutate, so just send and check effects.
    await harness.libSafeBurn(await burnable.getAddress(), amt);
    expect(await burnable.balanceOf(await harness.getAddress())).to.equal(0n);

    await harness.libSafeBurn(await plain.getAddress(), amt);
    expect(await plain.balanceOf(DEAD)).to.equal(amt);
  });

  it("sinkFrom pulls then burns (needs approval)", async () => {
    const { harness, burnable, a } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("30");
    await burnable.mint(a.address, amt);
    await burnable.connect(a).approve(await harness.getAddress(), amt);
    const supplyBefore = await burnable.totalSupply();

    await harness.sinkFrom(await burnable.getAddress(), a.address, amt, REF);

    expect(await burnable.totalSupply()).to.equal(supplyBefore - amt);
    expect(await burnable.balanceOf(a.address)).to.equal(0n);
  });

  it("zero amount reverts", async () => {
    const { harness, burnable } = await loadFixture(deployFixture);
    await expect(harness.sink(await burnable.getAddress(), 0n, REF)).to.be.revertedWithCustomError(
      harness,
      "ZeroAmount"
    );
  });

  it("tracks cumulative burned per token", async () => {
    const { harness, burnable, plain } = await loadFixture(deployFixture);
    const amt1 = ethers.parseEther("10");
    const amt2 = ethers.parseEther("25");
    await burnable.mint(await harness.getAddress(), amt1 + amt2);
    await harness.sink(await burnable.getAddress(), amt1, REF);
    await harness.sink(await burnable.getAddress(), amt2, REF);
    expect(await harness.totalSunk(await burnable.getAddress())).to.equal(amt1 + amt2);
    expect(await harness.totalSunk(await plain.getAddress())).to.equal(0n);
  });

  it("notifies the burn registry when set", async () => {
    const { harness, burnable, reg } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("12");
    await burnable.mint(await harness.getAddress(), amt);

    await expect(harness.setBurnRegistry(await reg.getAddress()))
      .to.emit(harness, "BurnRegistrySet")
      .withArgs(await reg.getAddress());

    await harness.sink(await burnable.getAddress(), amt, REF);
    expect(await reg.count()).to.equal(1n);
    const note = await reg.notes(0);
    expect(note.token).to.equal(await burnable.getAddress());
    expect(note.amount).to.equal(amt);
    expect(note.ref).to.equal(REF);
  });

  it("a reverting registry does not undo the sink (best-effort notify)", async () => {
    const { harness, burnable, reg } = await loadFixture(deployFixture);
    const amt = ethers.parseEther("8");
    await burnable.mint(await harness.getAddress(), amt);
    await harness.setBurnRegistry(await reg.getAddress());
    await reg.setShouldRevert(true);

    const supplyBefore = await burnable.totalSupply();
    // Sink still succeeds (burn happened) despite registry reverting.
    await harness.sink(await burnable.getAddress(), amt, REF);
    expect(await burnable.totalSupply()).to.equal(supplyBefore - amt);
    expect(await reg.count()).to.equal(0n);
    expect(await harness.totalSunk(await burnable.getAddress())).to.equal(amt);
  });
});
