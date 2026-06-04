const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AttestationStakeSlash", function () {
  let token, module, admin, attestor, slasher, treasury, outsider;
  const MIN_STAKE = 1000n;

  beforeEach(async () => {
    [admin, attestor, slasher, treasury, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Stake", "STK");

    const Module = await ethers.getContractFactory("AttestationStakeSlash");
    module = await Module.deploy(
      await token.getAddress(),
      MIN_STAKE,
      treasury.address,
      admin.address
    );

    await module.grantRole(await module.SLASHER_ROLE(), slasher.address);

    // fund + approve the attestor
    await token.mint(attestor.address, 10000n);
    await token.connect(attestor).approve(await module.getAddress(), 10000n);
  });

  it("stake makes an attestor active once at/above minStake", async () => {
    expect(await module.isActive(attestor.address)).to.equal(false);

    // below minStake: staked but still inactive
    await module.connect(attestor).stake(500n);
    expect(await module.stakeOf(attestor.address)).to.equal(500n);
    expect(await module.isActive(attestor.address)).to.equal(false);

    // crossing minStake activates
    await expect(module.connect(attestor).stake(500n))
      .to.emit(module, "Staked")
      .withArgs(attestor.address, 500n, 1000n);
    expect(await module.isActive(attestor.address)).to.equal(true);
  });

  it("attest works only when active", async () => {
    const claim = ethers.encodeBytes32String("claim-1");
    await expect(module.connect(attestor).attest(claim)).to.be.revertedWith("not active");

    await module.connect(attestor).stake(MIN_STAKE);
    await expect(module.connect(attestor).attest(claim))
      .to.emit(module, "Attested")
      .withArgs(attestor.address, claim);
  });

  it("slash reduces stake, sends to treasury, and can deactivate", async () => {
    await module.connect(attestor).stake(MIN_STAKE);
    expect(await module.isActive(attestor.address)).to.equal(true);

    const before = await token.balanceOf(treasury.address);
    await expect(module.connect(slasher).slash(attestor.address, 300n))
      .to.emit(module, "Slashed")
      .withArgs(attestor.address, 300n, 700n, treasury.address);

    expect(await module.stakeOf(attestor.address)).to.equal(700n);
    expect(await token.balanceOf(treasury.address)).to.equal(before + 300n);
    // dropped below minStake → deactivated
    expect(await module.isActive(attestor.address)).to.equal(false);
  });

  it("reverts when a non-slasher tries to slash", async () => {
    await module.connect(attestor).stake(MIN_STAKE);
    await expect(
      module.connect(outsider).slash(attestor.address, 100n)
    ).to.be.revertedWithCustomError(module, "AccessControlUnauthorizedAccount");
  });

  it("unstake returns funds and cannot exceed remaining (post-slash) balance", async () => {
    await module.connect(attestor).stake(MIN_STAKE);
    await module.connect(slasher).slash(attestor.address, 400n); // remaining 600

    // cannot pull more than what is left
    await expect(module.connect(attestor).unstake(601n)).to.be.revertedWith("amount>stake");

    const before = await token.balanceOf(attestor.address);
    await expect(module.connect(attestor).unstake(600n))
      .to.emit(module, "Unstaked")
      .withArgs(attestor.address, 600n, 0n);

    expect(await token.balanceOf(attestor.address)).to.equal(before + 600n);
    expect(await module.stakeOf(attestor.address)).to.equal(0n);
  });
});
