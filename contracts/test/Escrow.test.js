const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Escrow (arbiter-mediated ERC-20 escrow)", function () {
  let token, escrow, buyer, seller, arbiter, stranger;
  const AMOUNT = 1000n;

  beforeEach(async () => {
    [buyer, seller, arbiter, stranger] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Escrow Token", "ESC");
    await token.mint(buyer.address, AMOUNT);

    const Escrow = await ethers.getContractFactory("Escrow");
    escrow = await Escrow.deploy();

    await token.connect(buyer).approve(await escrow.getAddress(), AMOUNT);
  });

  async function open() {
    const tx = await escrow
      .connect(buyer)
      .open(seller.address, arbiter.address, await token.getAddress(), AMOUNT);
    await tx.wait();
    // first escrow id is 0
    return 0n;
  }

  it("open() pulls funds in and records a Funded escrow", async () => {
    const escrowAddr = await escrow.getAddress();
    await escrow
      .connect(buyer)
      .open(seller.address, arbiter.address, await token.getAddress(), AMOUNT);

    expect(await token.balanceOf(buyer.address)).to.equal(0n);
    expect(await token.balanceOf(escrowAddr)).to.equal(AMOUNT);

    const d = await escrow.escrows(0n);
    expect(d.buyer).to.equal(buyer.address);
    expect(d.seller).to.equal(seller.address);
    expect(d.arbiter).to.equal(arbiter.address);
    expect(d.amount).to.equal(AMOUNT);
    expect(d.state).to.equal(1n); // Funded
  });

  it("arbiter release() pays the seller", async () => {
    const id = await open();
    await expect(escrow.connect(arbiter).release(id))
      .to.emit(escrow, "Released")
      .withArgs(id, seller.address, AMOUNT);

    expect(await token.balanceOf(seller.address)).to.equal(AMOUNT);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect((await escrow.escrows(id)).state).to.equal(2n); // Released
  });

  it("arbiter refund() returns funds to the buyer (separate escrow)", async () => {
    const id = await open();
    await expect(escrow.connect(arbiter).refund(id))
      .to.emit(escrow, "Refunded")
      .withArgs(id, buyer.address, AMOUNT);

    expect(await token.balanceOf(buyer.address)).to.equal(AMOUNT);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect((await escrow.escrows(id)).state).to.equal(3n); // Refunded
  });

  it("non-arbiter cannot release or refund", async () => {
    const id = await open();
    await expect(
      escrow.connect(stranger).release(id)
    ).to.be.revertedWith("Escrow: not arbiter");
    await expect(
      escrow.connect(buyer).refund(id)
    ).to.be.revertedWith("Escrow: not arbiter");
  });

  it("cannot resolve twice", async () => {
    const id = await open();
    await escrow.connect(arbiter).release(id);
    await expect(
      escrow.connect(arbiter).release(id)
    ).to.be.revertedWith("Escrow: not funded");
    await expect(
      escrow.connect(arbiter).refund(id)
    ).to.be.revertedWith("Escrow: not funded");
  });
});
