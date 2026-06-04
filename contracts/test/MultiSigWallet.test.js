const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiSigWallet", function () {
  let ms, o1, o2, o3, recipient;

  beforeEach(async () => {
    [o1, o2, o3, recipient] = await ethers.getSigners();
    const MS = await ethers.getContractFactory("MultiSigWallet");
    ms = await MS.deploy([o1.address, o2.address, o3.address], 2); // 2-of-3
    await o1.sendTransaction({ to: await ms.getAddress(), value: 1000n });
  });

  it("executes a native transfer once threshold confirmations are reached", async () => {
    const id = 0;
    await ms.connect(o1).submit(recipient.address, 500n, "0x");
    await ms.connect(o1).confirm(id);
    // one confirmation is not enough
    await expect(ms.connect(o1).execute(id)).to.be.revertedWith("insufficient confirmations");

    await ms.connect(o2).confirm(id);
    const before = await ethers.provider.getBalance(recipient.address);
    await ms.connect(o2).execute(id);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(500n);
  });

  it("only owners can submit/confirm", async () => {
    await expect(ms.connect(recipient).submit(recipient.address, 1n, "0x")).to.be.revertedWith("not owner");
  });

  it("prevents double confirmation", async () => {
    await ms.connect(o1).submit(recipient.address, 1n, "0x");
    await ms.connect(o1).confirm(0);
    await expect(ms.connect(o1).confirm(0)).to.be.revertedWith("already confirmed");
  });
});
