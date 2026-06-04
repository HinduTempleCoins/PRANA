const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const SOURCE_ID = ethers.id("ERC20Initializable.standard-json");

describe("ERC20CloneFactory", function () {
  let factory, emitter, admin, creator, other;

  beforeEach(async () => {
    [admin, creator, other] = await ethers.getSigners();
    const E = await ethers.getContractFactory("DeploymentMetadataEmitter");
    emitter = await E.deploy();
    const F = await ethers.getContractFactory("ERC20CloneFactory");
    factory = await F.deploy(await emitter.getAddress(), SOURCE_ID);
  });

  it("clones, initializes, mints, and hands over all roles (no factory backdoor)", async () => {
    const CAP = 10n ** 24n;
    await factory.connect(creator).createToken("Clone", "CLN", CAP, 1000n, creator.address);
    expect(await factory.tokenCount()).to.equal(1n);

    const addr = await factory.allTokens(0);
    const t = await ethers.getContractAt("ERC20Initializable", addr);
    expect(await t.name()).to.equal("Clone");
    expect(await t.symbol()).to.equal("CLN");
    expect(await t.cap()).to.equal(CAP);
    expect(await t.balanceOf(creator.address)).to.equal(1000n);

    const MINTER = await t.MINTER_ROLE();
    const ADMIN = await t.DEFAULT_ADMIN_ROLE();
    expect(await t.hasRole(MINTER, creator.address)).to.equal(true);
    expect(await t.hasRole(ADMIN, creator.address)).to.equal(true);
    expect(await t.hasRole(MINTER, await factory.getAddress())).to.equal(false);
    expect(await t.hasRole(ADMIN, await factory.getAddress())).to.equal(false);
  });

  it("emits CloneCreated with the right fields", async () => {
    const CAP = 5000n;
    await expect(factory.connect(creator).createToken("Reg", "REG", CAP, 0n, ethers.ZeroAddress))
      .to.emit(factory, "CloneCreated")
      .withArgs(anyValue, creator.address, "Reg", "REG", CAP, ethers.ZeroHash);
  });

  it("records explorer metadata for each clone", async () => {
    const tx = await factory.connect(creator).createToken("Meta", "MET", 0n, 0n, ethers.ZeroAddress);
    const addr = await factory.allTokens(0);
    expect(await emitter.recorded(addr)).to.equal(true);
    await expect(tx)
      .to.emit(emitter, "DeploymentMetadata")
      .withArgs(addr, SOURCE_ID, anyValue, await factory.getAddress());
  });

  it("rejects re-initialization on a deployed clone", async () => {
    await factory.connect(creator).createToken("Once", "ONE", 0n, 0n, ethers.ZeroAddress);
    const addr = await factory.allTokens(0);
    const t = await ethers.getContractAt("ERC20Initializable", addr);
    await expect(
      t.connect(other).initialize("Evil", "EVL", 0n, other.address)
    ).to.be.revertedWithCustomError(t, "AlreadyInitialized");
  });

  it("rejects initializing the bare implementation (self-bricked)", async () => {
    const implAddr = await factory.implementation();
    const impl = await ethers.getContractAt("ERC20Initializable", implAddr);
    expect(await impl.initialized()).to.equal(true);
    await expect(
      impl.connect(other).initialize("Hijack", "HJ", 0n, other.address)
    ).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
  });

  it("predicts the deterministic address and deploys there", async () => {
    const salt = ethers.id("salt-1");
    const predicted = await factory.predictAddress(salt);
    await factory
      .connect(creator)
      .createTokenDeterministic("Det", "DET", 0n, 0n, ethers.ZeroAddress, salt);
    const addr = await factory.allTokens(0);
    expect(addr).to.equal(predicted);
  });

  it("reverts on a salt collision (already deployed)", async () => {
    const salt = ethers.id("dup");
    await factory.createTokenDeterministic("A", "A", 0n, 0n, ethers.ZeroAddress, salt);
    await expect(
      factory.createTokenDeterministic("B", "B", 0n, 0n, ethers.ZeroAddress, salt)
    ).to.be.reverted; // Clones reverts ERC1167FailedCreateClone on CREATE2 collision
  });

  it("keeps clone states independent", async () => {
    await factory.connect(creator).createToken("One", "ONE", 0n, 100n, creator.address);
    await factory.connect(other).createToken("Two", "TWO", 0n, 250n, other.address);
    const a = await ethers.getContractAt("ERC20Initializable", await factory.allTokens(0));
    const b = await ethers.getContractAt("ERC20Initializable", await factory.allTokens(1));

    expect(await a.name()).to.equal("One");
    expect(await b.name()).to.equal("Two");
    expect(await a.totalSupply()).to.equal(100n);
    expect(await b.totalSupply()).to.equal(250n);
    expect(await a.balanceOf(creator.address)).to.equal(100n);
    expect(await a.balanceOf(other.address)).to.equal(0n);
  });

  it("enforces the cap on the clone", async () => {
    const CAP = 1000n;
    // initialMint above cap is rejected by the factory pre-check
    await expect(
      factory.createToken("Cap", "CAP", CAP, 1001n, admin.address)
    ).to.be.revertedWithCustomError(factory, "CapBelowInitialMint");

    // mint up to cap, then over → token reverts CapExceeded
    await factory.connect(creator).createToken("Cap2", "CP2", CAP, 1000n, creator.address);
    const t = await ethers.getContractAt("ERC20Initializable", await factory.allTokens(0));
    await expect(t.connect(creator).mint(creator.address, 1n)).to.be.revertedWithCustomError(
      t,
      "CapExceeded"
    );
  });

  it("permit works on a clone with the correct (per-clone) domain", async () => {
    await factory.connect(creator).createToken("Perm", "PRM", 0n, 0n, ethers.ZeroAddress);
    const addr = await factory.allTokens(0);
    const t = await ethers.getContractAt("ERC20Initializable", addr);

    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "Perm",
      version: "1",
      chainId,
      verifyingContract: addr,
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      owner: creator.address,
      spender: other.address,
      value: 777n,
      nonce: await t.nonces(creator.address),
      deadline: ethers.MaxUint256,
    };
    const sig = await creator.signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(sig);

    await t.permit(creator.address, other.address, 777n, ethers.MaxUint256, v, r, s);
    expect(await t.allowance(creator.address, other.address)).to.equal(777n);
    expect(await t.nonces(creator.address)).to.equal(1n);
  });
});
