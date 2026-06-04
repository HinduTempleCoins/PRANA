const { expect } = require("chai");
const { ethers } = require("hardhat");

// Adversarial suite for MultiSigWallet: replay, quorum bypass, txId reuse, nonexistent tx,
// and non-owner access on every gated function.
//
// NOTE on "remove an owner below threshold": this MultiSigWallet has an IMMUTABLE owner set
// (no add/remove/changeThreshold functions exist). That is itself the defense — the m-of-n
// configuration is fixed at construction and cannot be lowered to bypass quorum. We assert
// that immutability instead of testing a nonexistent removal path.
describe("Adversarial: MultiSigWallet", function () {
  let ms, o1, o2, o3, mallory, recipient;

  beforeEach(async () => {
    [o1, o2, o3, mallory, recipient] = await ethers.getSigners();
    const MS = await ethers.getContractFactory("MultiSigWallet");
    ms = await MS.deploy([o1.address, o2.address, o3.address], 2); // 2-of-3
    await o1.sendTransaction({ to: await ms.getAddress(), value: 1000n });
  });

  // ---- replay of confirmation ----
  it("a confirmation cannot be replayed (double-confirm reverts)", async () => {
    await ms.connect(o1).submit(recipient.address, 100n, "0x");
    await ms.connect(o1).confirm(0);
    await expect(ms.connect(o1).confirm(0)).to.be.revertedWith("already confirmed");
    // confirmations counter not inflated by the replay attempt
    expect((await ms.transactions(0)).confirmations).to.equal(1n);
  });

  // ---- replay of execution ----
  it("an execution cannot be replayed (double-execute reverts, funds move once)", async () => {
    await ms.connect(o1).submit(recipient.address, 200n, "0x");
    await ms.connect(o1).confirm(0);
    await ms.connect(o2).confirm(0);

    const before = await ethers.provider.getBalance(recipient.address);
    await ms.connect(o1).execute(0);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(200n);

    await expect(ms.connect(o2).execute(0)).to.be.revertedWith("executed");
    // recipient was paid exactly once
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(after);
  });

  // ---- executing without quorum ----
  it("execute reverts below threshold confirmations", async () => {
    await ms.connect(o1).submit(recipient.address, 100n, "0x");
    await ms.connect(o1).confirm(0); // only 1 of 2 required
    await expect(ms.connect(o1).execute(0)).to.be.revertedWith("insufficient confirmations");
    await expect(ms.connect(o2).execute(0)).to.be.revertedWith("insufficient confirmations");
  });

  it("a single owner cannot reach quorum alone (no self double-count)", async () => {
    await ms.connect(o1).submit(recipient.address, 100n, "0x");
    await ms.connect(o1).confirm(0);
    // o1 cannot confirm again to fake a 2nd confirmation
    await expect(ms.connect(o1).confirm(0)).to.be.revertedWith("already confirmed");
    expect((await ms.transactions(0)).confirmations).to.equal(1n);
    await expect(ms.connect(o1).execute(0)).to.be.revertedWith("insufficient confirmations");
  });

  // ---- txId reuse / nonexistent tx ----
  it("confirming a nonexistent txId reverts", async () => {
    await expect(ms.connect(o1).confirm(0)).to.be.revertedWith("no tx");
    await expect(ms.connect(o1).confirm(999)).to.be.revertedWith("no tx");
  });

  it("executing a nonexistent txId reverts (out-of-bounds index)", async () => {
    // execute() indexes transactions[id] directly; an unknown id reverts (panic/array OOB)
    await expect(ms.connect(o1).execute(0)).to.be.reverted;
    await expect(ms.connect(o1).execute(42)).to.be.reverted;
  });

  it("txIds are monotonic and not reusable: each submit gets a fresh id", async () => {
    const id0 = await ms.connect(o1).submit.staticCall(recipient.address, 1n, "0x");
    await ms.connect(o1).submit(recipient.address, 1n, "0x");
    const id1 = await ms.connect(o1).submit.staticCall(recipient.address, 1n, "0x");
    await ms.connect(o1).submit(recipient.address, 1n, "0x");
    expect(id0).to.equal(0n);
    expect(id1).to.equal(1n);
    expect(await ms.txCount()).to.equal(2n);
    // each tx tracks its own independent confirmations / executed flag
    await ms.connect(o1).confirm(0);
    expect((await ms.transactions(0)).confirmations).to.equal(1n);
    expect((await ms.transactions(1)).confirmations).to.equal(0n);
  });

  // ---- non-owner access on every gated function ----
  it("non-owner cannot submit", async () => {
    await expect(
      ms.connect(mallory).submit(mallory.address, 1n, "0x")
    ).to.be.revertedWith("not owner");
  });

  it("non-owner cannot confirm", async () => {
    await ms.connect(o1).submit(recipient.address, 1n, "0x");
    await expect(ms.connect(mallory).confirm(0)).to.be.revertedWith("not owner");
  });

  it("non-owner cannot execute even a fully-confirmed tx", async () => {
    await ms.connect(o1).submit(recipient.address, 100n, "0x");
    await ms.connect(o1).confirm(0);
    await ms.connect(o2).confirm(0);
    await expect(ms.connect(mallory).execute(0)).to.be.revertedWith("not owner");
    // still executable by a real owner afterwards
    await ms.connect(o1).execute(0);
    expect((await ms.transactions(0)).executed).to.equal(true);
  });

  // ---- immutable owner set / threshold (no removal-below-threshold path exists) ----
  it("owner set and threshold are immutable: no function can lower quorum", async () => {
    expect(await ms.threshold()).to.equal(2n);
    expect(await ms.ownerCount()).to.equal(3n);
    // there is no removeOwner / changeThreshold / addOwner ABI entry to abuse
    const fnNames = ms.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    expect(fnNames).to.not.include("removeOwner");
    expect(fnNames).to.not.include("addOwner");
    expect(fnNames).to.not.include("changeThreshold");
    expect(fnNames).to.not.include("setThreshold");
  });

  it("a non-owner can never become counted toward quorum", async () => {
    expect(await ms.isOwner(mallory.address)).to.equal(false);
    await ms.connect(o1).submit(recipient.address, 100n, "0x");
    await ms.connect(o1).confirm(0);
    // mallory's confirm reverts, so quorum stays at 1 and execute fails
    await expect(ms.connect(mallory).confirm(0)).to.be.revertedWith("not owner");
    await expect(ms.connect(o1).execute(0)).to.be.revertedWith("insufficient confirmations");
  });
});
