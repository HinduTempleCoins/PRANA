const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Multicall3Full", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();

    const MC = await ethers.getContractFactory("Multicall3Full");
    const mc = await MC.deploy();
    await mc.waitForDeployment();

    // A simple token used as a call target for read aggregation.
    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Mock", "MK");
    await token.waitForDeployment();
    await token.mint(alice.address, 1000n);

    return { mc, token, deployer, alice, bob };
  }

  it("aggregate3 returns each call's success and data", async function () {
    const { mc, token, alice } = await loadFixture(deployFixture);
    const data = token.interface.encodeFunctionData("balanceOf", [alice.address]);

    const results = await mc.aggregate3.staticCall([
      { target: await token.getAddress(), allowFailure: false, callData: data },
    ]);
    expect(results[0].success).to.equal(true);
    const decoded = token.interface.decodeFunctionResult("balanceOf", results[0].returnData);
    expect(decoded[0]).to.equal(1000n);
  });

  it("aggregate3 honors allowFailure for a reverting call", async function () {
    const { mc, token } = await loadFixture(deployFixture);
    // transfer from the multicall (no balance) will revert.
    const badData = token.interface.encodeFunctionData("transfer", [
      ethers.ZeroAddress,
      1n,
    ]);

    const results = await mc.aggregate3.staticCall([
      { target: await token.getAddress(), allowFailure: true, callData: badData },
    ]);
    expect(results[0].success).to.equal(false);
  });

  it("aggregate3 reverts CallFailed when a disallowed call fails", async function () {
    const { mc, token } = await loadFixture(deployFixture);
    const badData = token.interface.encodeFunctionData("transfer", [
      ethers.ZeroAddress,
      1n,
    ]);
    await expect(
      mc.aggregate3([
        { target: await token.getAddress(), allowFailure: false, callData: badData },
      ])
    ).to.be.revertedWithCustomError(mc, "CallFailed");
  });

  it("aggregate3Value forwards ETH and enforces the exact total", async function () {
    const { mc, alice, bob } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");

    const before = await ethers.provider.getBalance(bob.address);
    await mc.connect(alice).aggregate3Value(
      [{ target: bob.address, allowFailure: false, value: amount, callData: "0x" }],
      { value: amount }
    );
    const after = await ethers.provider.getBalance(bob.address);
    expect(after - before).to.equal(amount);
  });

  it("aggregate3Value reverts on a value/msg.value mismatch", async function () {
    const { mc, alice, bob } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    await expect(
      mc.connect(alice).aggregate3Value(
        [{ target: bob.address, allowFailure: false, value: amount, callData: "0x" }],
        { value: amount + 1n }
      )
    ).to.be.revertedWithCustomError(mc, "ValueMismatch");
  });

  it("tryAggregate tolerates or enforces failures by flag", async function () {
    const { mc, token } = await loadFixture(deployFixture);
    const badData = token.interface.encodeFunctionData("transfer", [
      ethers.ZeroAddress,
      1n,
    ]);
    const calls = [{ target: await token.getAddress(), callData: badData }];

    const ok = await mc.tryAggregate.staticCall(false, calls);
    expect(ok[0].success).to.equal(false);

    await expect(mc.tryAggregate(true, calls)).to.be.revertedWithCustomError(mc, "CallFailed");
  });

  it("blockAndAggregate returns block number and hash", async function () {
    const { mc, token, alice } = await loadFixture(deployFixture);
    const data = token.interface.encodeFunctionData("balanceOf", [alice.address]);
    const res = await mc.blockAndAggregate.staticCall([
      { target: await token.getAddress(), callData: data },
    ]);
    expect(res.blockNumber).to.be.greaterThan(0n);
    expect(res.returnData[0].success).to.equal(true);
  });

  it("exposes block/chain helper getters", async function () {
    const { mc } = await loadFixture(deployFixture);
    const net = await ethers.provider.getNetwork();
    expect(await mc.getChainId()).to.equal(net.chainId);
    expect(await mc.getBlockNumber()).to.be.greaterThan(0n);
    expect(await mc.getCurrentBlockTimestamp()).to.be.greaterThan(0n);
    // getBasefee just needs to be callable.
    await mc.getBasefee();
  });
});
