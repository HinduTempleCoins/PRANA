const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MintSinkGuard", function () {
  let guard, admin, registrar, stranger;
  // Stand-in token / sink addresses (the guard is address-agnostic).
  // Canonical (all-lowercase) form so .withArgs matches ethers' EIP-55-normalized decode.
  const REWARD = "0x0000000000000000000000000000000000000a11";
  const SINK = "0x0000000000000000000000000000000000000b22";
  const SINK2 = "0x0000000000000000000000000000000000000c33";

  beforeEach(async () => {
    [admin, registrar, stranger] = await ethers.getSigners();
    const G = await ethers.getContractFactory("MintSinkGuard");
    guard = await G.deploy(admin.address);
  });

  it("registers a reward=>sink pair and lets assertSinkExists pass", async () => {
    await expect(guard.connect(admin).registerSink(REWARD, SINK))
      .to.emit(guard, "SinkRegistered")
      .withArgs(REWARD, SINK, admin.address);

    expect(await guard.sinkOf(REWARD)).to.equal(ethers.getAddress(SINK));
    expect(await guard.hasSink(REWARD)).to.equal(true);
    expect(await guard.registeredTokenCount()).to.equal(1n);
    await guard.assertSinkExists(REWARD); // does not revert
  });

  it("assertSinkExists reverts when no sink is registered (refuses unpaired mint)", async () => {
    await expect(guard.assertSinkExists(REWARD))
      .to.be.revertedWithCustomError(guard, "NoSinkRegistered")
      .withArgs(REWARD);
    expect(await guard.hasSink(REWARD)).to.equal(false);
  });

  it("only a registrar can register or unregister", async () => {
    await expect(
      guard.connect(stranger).registerSink(REWARD, SINK)
    ).to.be.revertedWithCustomError(guard, "AccessControlUnauthorizedAccount");

    await guard.connect(admin).registerSink(REWARD, SINK);
    await expect(
      guard.connect(stranger).unregisterSink(REWARD)
    ).to.be.revertedWithCustomError(guard, "AccessControlUnauthorizedAccount");
  });

  it("rejects zero token / zero sink and a duplicate identical pair", async () => {
    await expect(
      guard.connect(admin).registerSink(ethers.ZeroAddress, SINK)
    ).to.be.revertedWithCustomError(guard, "ZeroRewardToken");
    await expect(
      guard.connect(admin).registerSink(REWARD, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(guard, "ZeroSink");

    await guard.connect(admin).registerSink(REWARD, SINK);
    await expect(
      guard.connect(admin).registerSink(REWARD, SINK)
    ).to.be.revertedWithCustomError(guard, "AlreadyRegistered");
  });

  it("re-points to a new sink without duplicating the enumeration entry", async () => {
    await guard.connect(admin).registerSink(REWARD, SINK);
    await guard.connect(admin).registerSink(REWARD, SINK2);
    expect(await guard.sinkOf(REWARD)).to.equal(ethers.getAddress(SINK2));
    expect(await guard.registeredTokenCount()).to.equal(1n);
  });

  it("unregister removes the pairing so the guard refuses again", async () => {
    await guard.connect(admin).registerSink(REWARD, SINK);
    await expect(guard.connect(admin).unregisterSink(REWARD))
      .to.emit(guard, "SinkUnregistered")
      .withArgs(REWARD, SINK, admin.address);

    expect(await guard.hasSink(REWARD)).to.equal(false);
    await expect(guard.assertSinkExists(REWARD)).to.be.revertedWithCustomError(
      guard,
      "NoSinkRegistered"
    );

    await expect(
      guard.connect(admin).unregisterSink(REWARD)
    ).to.be.revertedWithCustomError(guard, "NoSinkRegistered");
  });
});
