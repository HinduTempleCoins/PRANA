const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const k = (s) => ethers.encodeBytes32String(s);
const ZERO = ethers.ZeroAddress;
const ZERO_KEY = ethers.ZeroHash;

describe("GameHub", function () {
  async function deployFixture() {
    const [admin, other, a1, a2, a3] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("GameHub");
    const hub = await Factory.deploy(admin.address);
    await hub.waitForDeployment();
    return { hub, admin, other, a1, a2, a3 };
  }

  it("grants admin roles to the constructor admin", async function () {
    const { hub, admin } = await loadFixture(deployFixture);
    const ADMIN_ROLE = await hub.ADMIN_ROLE();
    const DEFAULT_ADMIN_ROLE = await hub.DEFAULT_ADMIN_ROLE();
    expect(await hub.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
    expect(await hub.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
  });

  it("reverts deploy with zero admin", async function () {
    const Factory = await ethers.getContractFactory("GameHub");
    await expect(Factory.deploy(ZERO)).to.be.revertedWithCustomError(
      Factory,
      "ZeroAddress"
    );
  });

  it("registers a module at version 1 and emits", async function () {
    const { hub, a1 } = await loadFixture(deployFixture);
    await expect(hub.registerModule(k("farm"), a1.address))
      .to.emit(hub, "ModuleRegistered")
      .withArgs(k("farm"), a1.address, 1);

    expect(await hub.get(k("farm"))).to.equal(a1.address);
    expect(await hub.exists(k("farm"))).to.equal(true);
    expect(await hub.count()).to.equal(1n);
    const [addr, version] = await hub.getModule(k("farm"));
    expect(addr).to.equal(a1.address);
    expect(version).to.equal(1n);
  });

  it("rejects zero key and zero address on register", async function () {
    const { hub, a1 } = await loadFixture(deployFixture);
    await expect(
      hub.registerModule(ZERO_KEY, a1.address)
    ).to.be.revertedWithCustomError(hub, "ZeroKey");
    await expect(
      hub.registerModule(k("farm"), ZERO)
    ).to.be.revertedWithCustomError(hub, "ZeroAddress");
  });

  it("rejects double registration", async function () {
    const { hub, a1, a2 } = await loadFixture(deployFixture);
    await hub.registerModule(k("farm"), a1.address);
    await expect(hub.registerModule(k("farm"), a2.address))
      .to.be.revertedWithCustomError(hub, "AlreadyRegistered")
      .withArgs(k("farm"));
  });

  it("updates an existing module, bumping the version", async function () {
    const { hub, a1, a2 } = await loadFixture(deployFixture);
    await hub.registerModule(k("market"), a1.address);
    await expect(hub.updateModule(k("market"), a2.address))
      .to.emit(hub, "ModuleUpdated")
      .withArgs(k("market"), a2.address, 2);

    const [addr, version] = await hub.getModule(k("market"));
    expect(addr).to.equal(a2.address);
    expect(version).to.equal(2n);
    expect(await hub.count()).to.equal(1n);
  });

  it("rejects update of an unregistered key", async function () {
    const { hub, a1 } = await loadFixture(deployFixture);
    await expect(hub.updateModule(k("ghost"), a1.address))
      .to.be.revertedWithCustomError(hub, "NotRegistered")
      .withArgs(k("ghost"));
  });

  it("removes a module", async function () {
    const { hub, a1 } = await loadFixture(deployFixture);
    await hub.registerModule(k("crafting"), a1.address);
    await expect(hub.removeModule(k("crafting")))
      .to.emit(hub, "ModuleRemoved")
      .withArgs(k("crafting"));
    expect(await hub.exists(k("crafting"))).to.equal(false);
    expect(await hub.get(k("crafting"))).to.equal(ZERO);
    expect(await hub.count()).to.equal(0n);
  });

  it("rejects removal of an unregistered key", async function () {
    const { hub } = await loadFixture(deployFixture);
    await expect(hub.removeModule(k("nope")))
      .to.be.revertedWithCustomError(hub, "NotRegistered")
      .withArgs(k("nope"));
  });

  it("only ADMIN_ROLE can register/update/remove", async function () {
    const { hub, other, a1 } = await loadFixture(deployFixture);
    const ADMIN_ROLE = await hub.ADMIN_ROLE();
    await expect(hub.connect(other).registerModule(k("farm"), a1.address))
      .to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount")
      .withArgs(ethers.getAddress(other.address), ADMIN_ROLE);
  });

  it("getAll enumerates the whole suite", async function () {
    const { hub, a1, a2, a3 } = await loadFixture(deployFixture);
    await hub.registerModule(k("creatures"), a1.address);
    await hub.registerModule(k("farm"), a2.address);
    await hub.registerModule(k("market"), a3.address);
    await hub.updateModule(k("farm"), a1.address); // farm -> v2

    const [keys, addrs, versions] = await hub.getAll();
    expect(keys.length).to.equal(3);

    const byKey = {};
    for (let i = 0; i < keys.length; i++) {
      byKey[keys[i]] = { addr: addrs[i], version: versions[i] };
    }
    expect(byKey[k("creatures")].addr).to.equal(a1.address);
    expect(byKey[k("creatures")].version).to.equal(1n);
    expect(byKey[k("farm")].addr).to.equal(a1.address);
    expect(byKey[k("farm")].version).to.equal(2n);
    expect(byKey[k("market")].addr).to.equal(a3.address);

    const allKeys = await hub.allKeys();
    expect(allKeys.length).to.equal(3);
    expect(await hub.keyAt(0)).to.equal(keys[0]);
  });

  it("removal keeps getAll consistent (swap-and-pop)", async function () {
    const { hub, a1, a2, a3 } = await loadFixture(deployFixture);
    await hub.registerModule(k("creatures"), a1.address);
    await hub.registerModule(k("farm"), a2.address);
    await hub.registerModule(k("market"), a3.address);
    await hub.removeModule(k("farm"));

    const [keys] = await hub.getAll();
    expect(keys.length).to.equal(2);
    expect(keys).to.not.include(k("farm"));
    expect(keys).to.include(k("creatures"));
    expect(keys).to.include(k("market"));
  });
});
