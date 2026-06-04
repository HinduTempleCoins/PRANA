const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { buildOp, signOp, encodeExecute } = require("./helpers");

describe("SessionKeyValidator (AA session keys)", function () {
  const PREFUND = ethers.parseEther("0.01");

  async function deployFixture() {
    const [deployer, ownerEoa, beneficiary] = await ethers.getSigners();
    // a fresh random wallet to act as the session key (so we control its private key)
    const sessionKey = ethers.Wallet.createRandom().connect(ethers.provider);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const EP = await (await ethers.getContractFactory("MinimalEntryPoint")).deploy();
    await EP.waitForDeployment();
    const epAddr = await EP.getAddress();

    const account = await (await ethers.getContractFactory("SmartAccount")).deploy(
      epAddr,
      ownerEoa.address
    );
    await account.waitForDeployment();
    const acctAddr = await account.getAddress();

    const validator = await (await ethers.getContractFactory("SessionKeyValidator")).deploy();
    await validator.waitForDeployment();

    const target = await (await ethers.getContractFactory("CallTargetMock")).deploy();
    await target.waitForDeployment();
    const tAddr = await target.getAddress();

    // wire the module + fund the account deposit + native balance
    await account.connect(ownerEoa).setSessionValidator(await validator.getAddress());
    await EP.depositTo(acctAddr, { value: ethers.parseEther("1") });
    await deployer.sendTransaction({ to: acctAddr, value: ethers.parseEther("2") });

    const setNumberSel = target.interface.getFunction("setNumber").selector;
    const forbiddenSel = target.interface.getFunction("forbidden").selector;

    return {
      EP, epAddr, account, acctAddr, validator, target, tAddr,
      ownerEoa, beneficiary, sessionKey, chainId, setNumberSel, forbiddenSel, deployer,
    };
  }

  // register a session for the sessionKey, scoped to target.setNumber
  async function registerSession(ctx, overrides = {}) {
    const now = await time.latest();
    const {
      validAfter = 0,
      validUntil = now + 100000,
      target = ctx.tAddr,
      selector = ctx.setNumberSel,
      valueCap = ethers.parseEther("0.5"),
      spendCap = ethers.parseEther("1"),
    } = overrides;
    // registerSession is called BY the account; route it through an owner execute()
    const data = ctx.validator.interface.encodeFunctionData("registerSession", [
      ctx.sessionKey.address,
      target,
      selector,
      validAfter,
      validUntil,
      valueCap,
      spendCap,
    ]);
    await ctx.account
      .connect(ctx.ownerEoa)
      .execute(await ctx.validator.getAddress(), 0n, data);
  }

  // build an op that calls execute(target, value, setNumber(n)) signed by the session key
  async function sessionOp(ctx, n, value, nonce = 0n, target = ctx.tAddr) {
    const inner = ctx.target.interface.encodeFunctionData("setNumber", [n]);
    const callData = encodeExecute(ctx.account, target, value, inner);
    const op = buildOp({ sender: ctx.acctAddr, nonce, callData });
    await signOp(op, ctx.sessionKey, ctx.sessionKey.address, ctx.epAddr, ctx.chainId);
    return op;
  }

  it("executes a session-signed op within scope", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx);
    const op = await sessionOp(ctx, 77n, ethers.parseEther("0.1"));

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.emit(ctx.EP, "UserOperationEvent");

    expect(await ctx.target.stored()).to.equal(77n);
    // spend recorded
    expect(await ctx.validator.remaining(ctx.acctAddr, ctx.sessionKey.address)).to.equal(
      ethers.parseEther("1") - ethers.parseEther("0.1")
    );
  });

  it("rejects an out-of-scope target (AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx);
    // call a DIFFERENT target address than the scoped one
    const otherTarget = await (await ethers.getContractFactory("CallTargetMock")).deploy();
    await otherTarget.waitForDeployment();
    const op = await sessionOp(ctx, 1n, 0n, 0n, await otherTarget.getAddress());

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("rejects an out-of-scope selector (AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx);
    // inner call uses forbidden() instead of setNumber()
    const inner = ctx.target.interface.encodeFunctionData("forbidden", [1n]);
    const callData = encodeExecute(ctx.account, ctx.tAddr, 0n, inner);
    const op = buildOp({ sender: ctx.acctAddr, callData });
    await signOp(op, ctx.sessionKey, ctx.sessionKey.address, ctx.epAddr, ctx.chainId);

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("rejects a per-op value over the valueCap (AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx, { valueCap: ethers.parseEther("0.1") });
    const op = await sessionOp(ctx, 5n, ethers.parseEther("0.2")); // > valueCap

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("enforces the cumulative spendCap across ops (AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx, {
      valueCap: ethers.parseEther("0.6"),
      spendCap: ethers.parseEther("0.6"),
    });
    // first op spends 0.4 (ok)
    const op0 = await sessionOp(ctx, 1n, ethers.parseEther("0.4"), 0n);
    await ctx.EP.handleOps([{ op: op0, prefund: PREFUND }], ctx.beneficiary.address);
    expect(await ctx.validator.remaining(ctx.acctAddr, ctx.sessionKey.address)).to.equal(
      ethers.parseEther("0.2")
    );
    // second op spends 0.4 → cumulative 0.8 > 0.6 cap → reject
    const op1 = await sessionOp(ctx, 2n, ethers.parseEther("0.4"), 1n);
    await expect(ctx.EP.handleOps([{ op: op1, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("rejects an expired session via the validationData time-range (AA22)", async function () {
    const ctx = await loadFixture(deployFixture);
    const now = await time.latest();
    await registerSession(ctx, { validUntil: now + 50 });
    await time.increase(100); // now past validUntil
    const op = await sessionOp(ctx, 9n, 0n);

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA22");
  });

  it("rejects a not-yet-valid session via the time-range (AA22)", async function () {
    const ctx = await loadFixture(deployFixture);
    const now = await time.latest();
    await registerSession(ctx, { validAfter: now + 10000, validUntil: now + 20000 });
    const op = await sessionOp(ctx, 9n, 0n);

    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA22");
  });

  it("owner can revoke a session; revoked op is rejected (AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    await registerSession(ctx);
    // revoke via owner execute()
    const data = ctx.validator.interface.encodeFunctionData("revokeSession", [
      ctx.sessionKey.address,
    ]);
    await ctx.account.connect(ctx.ownerEoa).execute(await ctx.validator.getAddress(), 0n, data);

    const op = await sessionOp(ctx, 3n, 0n);
    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });

  it("with no module wired, only the owner can sign (session key fails AA24)", async function () {
    const ctx = await loadFixture(deployFixture);
    // clear the module
    await ctx.account.connect(ctx.ownerEoa).setSessionValidator(ethers.ZeroAddress);
    const op = await sessionOp(ctx, 1n, 0n);
    await expect(ctx.EP.handleOps([{ op, prefund: PREFUND }], ctx.beneficiary.address))
      .to.be.revertedWithCustomError(ctx.EP, "FailedOp")
      .withArgs(0, "AA24");
  });
});
