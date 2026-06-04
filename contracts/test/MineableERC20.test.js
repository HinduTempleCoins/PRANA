const { expect } = require("chai");
const { ethers } = require("hardhat");

const MAX_UINT256 = (1n << 256n) - 1n;
const REWARD = ethers.parseUnits("50", 18);

describe("MineableERC20", function () {
  async function deploy(target) {
    const [miner] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MineableERC20");
    const token = await Factory.deploy(target, REWARD);
    await token.waitForDeployment();
    return { token, miner };
  }

  it("mints the reward to the miner when a nonce satisfies the target", async function () {
    const { token, miner } = await deploy(MAX_UINT256);
    expect(await token.balanceOf(miner.address)).to.equal(0n);

    await token.mint(0);

    expect(await token.balanceOf(miner.address)).to.equal(REWARD);
  });

  it("mints exactly the configured reward amount", async function () {
    const { token, miner } = await deploy(MAX_UINT256);

    await token.mint(123);

    expect(await token.balanceOf(miner.address)).to.equal(REWARD);
    expect(await token.totalSupply()).to.equal(REWARD);
    expect(await token.reward()).to.equal(REWARD);
  });

  it("rolls a new challengeNumber after a successful mint", async function () {
    const { token } = await deploy(MAX_UINT256);
    const before = await token.challengeNumber();

    await token.mint(0);

    const after = await token.challengeNumber();
    expect(after).to.not.equal(before);
  });

  it("advances the challenge on every mint (each mint differs)", async function () {
    const { token } = await deploy(MAX_UINT256);

    const c0 = await token.challengeNumber();
    await token.mint(1);
    const c1 = await token.challengeNumber();
    await token.mint(2);
    const c2 = await token.challengeNumber();

    expect(c0).to.not.equal(c1);
    expect(c1).to.not.equal(c2);
    expect(c0).to.not.equal(c2);
  });

  it("reverts with 'difficulty' when the target is zero", async function () {
    const { token } = await deploy(0n);

    await expect(token.mint(0)).to.be.revertedWith("difficulty");
  });
});
