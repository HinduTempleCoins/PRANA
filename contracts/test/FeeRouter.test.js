const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FeeRouter", function () {
  let token, a, b, c;

  beforeEach(async () => {
    [, a, b, c] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Fee", "FEE");
  });

  async function deployRouter(dests, bps) {
    const F = await ethers.getContractFactory("FeeRouter");
    return F.deploy(dests, bps);
  }

  it("rejects bps that do not sum to 10000", async () => {
    const F = await ethers.getContractFactory("FeeRouter");
    await expect(
      deployRouter([a.address, b.address], [5000, 4000])
    ).to.be.revertedWithCustomError(F, "BpsSumNot10000");

    await expect(
      deployRouter([a.address, b.address], [6000, 5000])
    ).to.be.revertedWithCustomError(F, "BpsSumNot10000");
  });

  it("rejects mismatched array lengths and empty config", async () => {
    const F = await ethers.getContractFactory("FeeRouter");
    await expect(
      deployRouter([a.address], [5000, 5000])
    ).to.be.revertedWithCustomError(F, "LengthMismatch");
    await expect(deployRouter([], [])).to.be.revertedWithCustomError(
      F,
      "NoDestinations"
    );
  });

  it("splits a deposited balance correctly across 3 destinations", async () => {
    // 50% / 30% / 20%
    const router = await deployRouter(
      [a.address, b.address, c.address],
      [5000, 3000, 2000]
    );
    await token.mint(await router.getAddress(), 10000n);

    await router.distribute(await token.getAddress());

    expect(await token.balanceOf(a.address)).to.equal(5000n);
    expect(await token.balanceOf(b.address)).to.equal(3000n);
    expect(await token.balanceOf(c.address)).to.equal(2000n);
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("gives the remainder (dust) to the last destination on odd amounts", async () => {
    // 1/3, 1/3, 1/3-ish: 3333 / 3333 / 3334 bps -> must sum to 10000
    const router = await deployRouter(
      [a.address, b.address, c.address],
      [3333, 3333, 3334]
    );
    // 100 wei: floor(100*3333/10000)=33 each for first two; last sweeps 100-66=34
    await token.mint(await router.getAddress(), 100n);

    await router.distribute(await token.getAddress());

    expect(await token.balanceOf(a.address)).to.equal(33n);
    expect(await token.balanceOf(b.address)).to.equal(33n);
    expect(await token.balanceOf(c.address)).to.equal(34n);
    // nothing stuck in the router
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("no-ops on an empty balance", async () => {
    const router = await deployRouter([a.address, b.address], [7000, 3000]);
    await expect(router.distribute(await token.getAddress())).to.not.be.reverted;
    expect(await token.balanceOf(a.address)).to.equal(0n);
    expect(await token.balanceOf(b.address)).to.equal(0n);
  });

  it("can distribute repeatedly as new fees arrive", async () => {
    const router = await deployRouter([a.address, b.address], [7500, 2500]);

    await token.mint(await router.getAddress(), 400n);
    await router.distribute(await token.getAddress());
    expect(await token.balanceOf(a.address)).to.equal(300n);
    expect(await token.balanceOf(b.address)).to.equal(100n);

    await token.mint(await router.getAddress(), 800n);
    await router.distribute(await token.getAddress());
    expect(await token.balanceOf(a.address)).to.equal(900n);
    expect(await token.balanceOf(b.address)).to.equal(300n);
  });
});
