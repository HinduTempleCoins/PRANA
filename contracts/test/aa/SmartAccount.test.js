const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { buildOp, signOp, encodeExecute } = require("./helpers");

describe("SmartAccount + MinimalEntryPoint", function () {
  const PREFUND = ethers.parseEther("0.01");

  async function deployFixture() {
    const [deployer, ownerEoa, beneficiary, stranger] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const EP = await ethers.getContractFactory("MinimalEntryPoint");
    const ep = await EP.deploy();
    await ep.waitForDeployment();
    const epAddr = await ep.getAddress();

    const Acct = await ethers.getContractFactory("SmartAccount");
    const account = await Acct.deploy(epAddr, ownerEoa.address);
    await account.waitForDeployment();
    const acctAddr = await account.getAddress();

    const Target = await ethers.getContractFactory("CallTargetMock");
    const target = await Target.deploy();
    await target.waitForDeployment();

    // Prefund the account's deposit at the entry point.
    await ep.depositTo(acctAddr, { value: ethers.parseEther("1") });

    return { ep, epAddr, account, acctAddr, target, ownerEoa, beneficiary, stranger, chainId, deployer };
  }

  async function ownerOpToSetNumber(ctx, n, nonce = 0n) {
    const { account, acctAddr, target, ownerEoa, epAddr, chainId } = ctx;
    const inner = target.interface.encodeFunctionData("setNumber", [n]);
    const callData = encodeExecute(account, await target.getAddress(), 0n, inner);
    const op = buildOp({ sender: acctAddr, nonce, callData });
    await signOp(op, ownerEoa, ownerEoa.address, epAddr, chainId);
    return op;
  }

  it("executes a target call via owner-signed op through the entry point", async function () {
    const ctx = await loadFixture(deployFixture);
    const op = await ownerOpToSetNumber(ctx, 42n);

    await expect(ctx.ep.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.emit(ctx.ep, "UserOperationEvent");

    expect(await ctx.target.stored()).to.equal(42n);
    expect(await ctx.target.lastCaller()).to.equal(ctx.acctAddr);
  });

  it("pays prefund from the account deposit to the beneficiary", async function () {
    const ctx = await loadFixture(deployFixture);
    const op = await ownerOpToSetNumber(ctx, 7n);

    const before = await ctx.ep.balanceOf(ctx.acctAddr);
    const benBefore = await ethers.provider.getBalance(ctx.beneficiary.address);

    await ctx.ep.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address);

    expect(await ctx.ep.balanceOf(ctx.acctAddr)).to.equal(before - PREFUND);
    expect(await ethers.provider.getBalance(ctx.beneficiary.address)).to.equal(benBefore + PREFUND);
  });

  it("rejects a bad signature with AA24", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, acctAddr, target, stranger, epAddr, chainId } = ctx;
    const inner = target.interface.encodeFunctionData("setNumber", [1n]);
    const callData = encodeExecute(account, await target.getAddress(), 0n, inner);
    const op = buildOp({ sender: acctAddr, callData });
    // stranger signs but declares the owner address — recovery mismatches the declared signer.
    await signOp(op, stranger, (await account.owner()), epAddr, chainId);

    await expect(ctx.ep.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.ep, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("blocks nonce replay (AA25 on reuse)", async function () {
    const ctx = await loadFixture(deployFixture);
    const op0 = await ownerOpToSetNumber(ctx, 11n, 0n);
    await ctx.ep.handleOps([{ op: op0, prefund: PREFUND }], ctx.beneficiary.address);

    // Reuse the same op (nonce 0 already consumed).
    await expect(ctx.ep.handleOps([{ op: op0, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.ep, "FailedOp")
      .withArgs(0, "AA25");

    // A fresh nonce works.
    const op1 = await ownerOpToSetNumber(ctx, 12n, 1n);
    await ctx.ep.handleOps([{ op: op1, prefund: PREFUND }], ctx.beneficiary.address);
    expect(await ctx.target.stored()).to.equal(12n);
  });

  it("reverts AA21 when the account deposit cannot cover the prefund", async function () {
    const ctx = await loadFixture(deployFixture);
    const op = await ownerOpToSetNumber(ctx, 5n);
    const huge = ethers.parseEther("1000");
    await expect(ctx.ep.handleOps([{ op, prefund: huge }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.ep, "FailedOp")
      .withArgs(0, "AA21");
  });

  it("owner can rotate the owner; old owner sig then fails", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, ownerEoa, stranger } = ctx;

    await expect(account.connect(ownerEoa).rotateOwner(stranger.address))
      .to.emit(account, "OwnerRotated")
      .withArgs(ownerEoa.address, stranger.address);
    expect(await account.owner()).to.equal(stranger.address);

    // non-owner cannot rotate
    await expect(account.connect(ownerEoa).rotateOwner(ownerEoa.address))
      .to.be.revertedWithCustomError(account, "NotOwner");

    // An op signed by the OLD owner now fails AA24.
    const op = await ownerOpToSetNumber(ctx, 9n);
    await expect(ctx.ep.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.ep, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("owner can call execute directly; stranger cannot", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, target, ownerEoa, stranger } = ctx;
    const inner = target.interface.encodeFunctionData("setNumber", [99n]);
    await account.connect(ownerEoa).execute(await target.getAddress(), 0n, inner);
    expect(await target.stored()).to.equal(99n);

    await expect(account.connect(stranger).execute(await target.getAddress(), 0n, inner))
      .to.be.revertedWithCustomError(account, "NotEntryPointOrOwner");
  });

  it("executeBatch runs multiple calls; length mismatch reverts", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, target, ownerEoa } = ctx;
    const tAddr = await target.getAddress();
    const a = target.interface.encodeFunctionData("setNumber", [1n]);
    const b = target.interface.encodeFunctionData("ping", []);

    await account.connect(ownerEoa).executeBatch([tAddr, tAddr], [0n, 0n], [a, b]);
    expect(await target.stored()).to.equal(1n);
    expect(await target.pings()).to.equal(1n);

    await expect(
      account.connect(ownerEoa).executeBatch([tAddr], [0n, 0n], [a])
    ).to.be.revertedWithCustomError(account, "BadBatchLengths");
  });

  it("EIP-1271 validates an owner signature and rejects others", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, ownerEoa, stranger } = ctx;
    const msg = ethers.id("hello");
    const goodSig = await ownerEoa.signMessage(ethers.getBytes(msg));
    const badSig = await stranger.signMessage(ethers.getBytes(msg));

    expect(await account.isValidSignature(msg, goodSig)).to.equal("0x1626ba7e");
    expect(await account.isValidSignature(msg, badSig)).to.equal("0xffffffff");
  });

  it("forwards native value through the account to the target", async function () {
    const ctx = await loadFixture(deployFixture);
    const { account, acctAddr, target, ownerEoa, epAddr, chainId, deployer } = ctx;
    // fund the account with native value to forward
    await deployer.sendTransaction({ to: acctAddr, value: ethers.parseEther("0.5") });

    const sendVal = ethers.parseEther("0.2");
    const inner = target.interface.encodeFunctionData("setNumber", [3n]);
    const callData = encodeExecute(account, await target.getAddress(), sendVal, inner);
    const op = buildOp({ sender: acctAddr, callData });
    await signOp(op, ownerEoa, ownerEoa.address, epAddr, chainId);

    await ctx.ep.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address);
    expect(await target.lastValue()).to.equal(sendVal);
    expect(await ethers.provider.getBalance(await target.getAddress())).to.equal(sendVal);
  });
});

describe("SmartAccountFactory", function () {
  async function deployFixture() {
    const [deployer, ownerEoa] = await ethers.getSigners();
    const EP = await ethers.getContractFactory("MinimalEntryPoint");
    const ep = await EP.deploy();
    await ep.waitForDeployment();
    const Factory = await ethers.getContractFactory("SmartAccountFactory");
    const factory = await Factory.deploy(await ep.getAddress());
    await factory.waitForDeployment();
    return { ep, factory, ownerEoa, deployer };
  }

  it("predicts the address and deploys there", async function () {
    const { factory, ownerEoa } = await loadFixture(deployFixture);
    const salt = ethers.id("salt-1");
    const predicted = await factory.predictAddress(ownerEoa.address, salt);

    await expect(factory.createAccount(ownerEoa.address, salt))
      .to.emit(factory, "AccountCreated")
      .withArgs(predicted, ownerEoa.address, salt);

    expect((await ethers.provider.getCode(predicted)).length).to.be.greaterThan(2);
    const account = await ethers.getContractAt("SmartAccount", predicted);
    expect(await account.owner()).to.equal(ownerEoa.address);
  });

  it("is idempotent: second create returns the same address, no redeploy", async function () {
    const { factory, ownerEoa } = await loadFixture(deployFixture);
    const salt = ethers.id("salt-2");
    const predicted = await factory.predictAddress(ownerEoa.address, salt);
    await factory.createAccount(ownerEoa.address, salt);
    // second call must not emit AccountCreated (returns existing)
    await expect(factory.createAccount(ownerEoa.address, salt)).to.not.emit(factory, "AccountCreated");
    expect(await factory.predictAddress(ownerEoa.address, salt)).to.equal(predicted);
  });

  it("different salts give different addresses", async function () {
    const { factory, ownerEoa } = await loadFixture(deployFixture);
    const a = await factory.predictAddress(ownerEoa.address, ethers.id("a"));
    const b = await factory.predictAddress(ownerEoa.address, ethers.id("b"));
    expect(a).to.not.equal(b);
  });
});
