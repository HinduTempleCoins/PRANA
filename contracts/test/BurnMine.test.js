const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BurnMine (fixed-ratio burn-to-mint)", function () {
  let input, output, mine, admin, user;
  const RATIO_NUM = 1n;   // 10 input  ->  1 output
  const RATIO_DEN = 10n;

  beforeEach(async () => {
    [admin, user] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    input = await Mock.deploy("Input", "IN");

    const PoL = await ethers.getContractFactory("PoLToken");
    output = await PoL.deploy(admin.address);

    const Mine = await ethers.getContractFactory("BurnMine");
    mine = await Mine.deploy(
      await input.getAddress(),
      await output.getAddress(),
      RATIO_NUM,
      RATIO_DEN
    );

    // the mine must be allowed to mint the output token
    const MINTER = await output.MINTER_ROLE();
    await output.grantRole(MINTER, await mine.getAddress());

    // fund the user with input tokens
    await input.mint(user.address, 1000n);
  });

  it("quotes output by the configured ratio", async () => {
    expect(await mine.quote(1000n)).to.equal(100n);
    expect(await mine.quote(9n)).to.equal(0n); // floor division
  });

  it("burns the input and mints the output at the ratio", async () => {
    await input.connect(user).approve(await mine.getAddress(), 1000n);
    await expect(mine.connect(user).mine(1000n))
      .to.emit(mine, "Mined")
      .withArgs(user.address, 1000n, 100n);

    expect(await output.balanceOf(user.address)).to.equal(100n);
    expect(await input.balanceOf(user.address)).to.equal(0n);
    expect(await input.totalSupply()).to.equal(0n);     // input was truly burned
    expect(await mine.totalBurned()).to.equal(1000n);
    expect(await mine.totalMinted()).to.equal(100n);
  });

  it("reverts on zero input", async () => {
    await expect(mine.connect(user).mine(0n)).to.be.revertedWith("amount=0");
  });

  it("reverts when the output would round to zero", async () => {
    await input.connect(user).approve(await mine.getAddress(), 5n);
    await expect(mine.connect(user).mine(5n)).to.be.revertedWith("out=0");
  });

  it("requires the caller to approve the input first", async () => {
    await expect(mine.connect(user).mine(100n)).to.be.reverted;
  });

  it("rejects a bad ratio at construction", async () => {
    const Mine = await ethers.getContractFactory("BurnMine");
    await expect(
      Mine.deploy(await input.getAddress(), await output.getAddress(), 0, 10)
    ).to.be.revertedWith("bad ratio");
  });
});
