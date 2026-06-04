const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Multicall", function () {
  let multicall, token, alice, bob;
  let erc20Iface;

  beforeEach(async function () {
    [, alice, bob] = await ethers.getSigners();

    const Multicall = await ethers.getContractFactory("Multicall");
    multicall = await Multicall.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock", "MOCK");

    await token.mint(alice.address, 1000n);
    await token.mint(bob.address, 2500n);

    erc20Iface = token.interface;
  });

  it("aggregates two staticcalls and decodes the results", async function () {
    const calls = [
      {
        target: await token.getAddress(),
        callData: erc20Iface.encodeFunctionData("balanceOf", [alice.address]),
      },
      {
        target: await token.getAddress(),
        callData: erc20Iface.encodeFunctionData("balanceOf", [bob.address]),
      },
    ];

    const [blockNumber, returnData] = await multicall.aggregate.staticCall(calls);

    expect(blockNumber).to.be.gt(0n);
    expect(returnData.length).to.equal(2);

    const aliceBal = erc20Iface.decodeFunctionResult("balanceOf", returnData[0])[0];
    const bobBal = erc20Iface.decodeFunctionResult("balanceOf", returnData[1])[0];

    expect(aliceBal).to.equal(1000n);
    expect(bobBal).to.equal(2500n);
  });

  it("aggregate reverts when any call fails", async function () {
    const calls = [
      {
        target: await token.getAddress(),
        callData: erc20Iface.encodeFunctionData("balanceOf", [alice.address]),
      },
      {
        // calling a non-existent selector on an EOA -> empty code -> call to
        // a contract with bad data; use a target with no matching function.
        target: await multicall.getAddress(),
        callData: erc20Iface.encodeFunctionData("balanceOf", [bob.address]),
      },
    ];

    await expect(multicall.aggregate.staticCall(calls)).to.be.revertedWith(
      "Multicall: call failed"
    );
  });

  it("aggregate3 with allowFailure=true captures failure without reverting", async function () {
    const calls = [
      {
        target: await token.getAddress(),
        allowFailure: false,
        callData: erc20Iface.encodeFunctionData("balanceOf", [alice.address]),
      },
      {
        target: await multicall.getAddress(),
        allowFailure: true,
        callData: erc20Iface.encodeFunctionData("balanceOf", [bob.address]),
      },
    ];

    const results = await multicall.aggregate3.staticCall(calls);

    expect(results.length).to.equal(2);
    expect(results[0].success).to.equal(true);
    expect(results[1].success).to.equal(false);

    const aliceBal = erc20Iface.decodeFunctionResult(
      "balanceOf",
      results[0].returnData
    )[0];
    expect(aliceBal).to.equal(1000n);
    expect(results[1].returnData).to.equal("0x");
  });

  it("aggregate3 reverts when a non-allowFailure call fails", async function () {
    const calls = [
      {
        target: await multicall.getAddress(),
        allowFailure: false,
        callData: erc20Iface.encodeFunctionData("balanceOf", [alice.address]),
      },
    ];

    await expect(multicall.aggregate3.staticCall(calls)).to.be.revertedWith(
      "Multicall: call failed"
    );
  });

  it("aggregate3 returns all successes for a fully-valid batch", async function () {
    const calls = [
      {
        target: await token.getAddress(),
        allowFailure: false,
        callData: erc20Iface.encodeFunctionData("balanceOf", [alice.address]),
      },
      {
        target: await token.getAddress(),
        allowFailure: false,
        callData: erc20Iface.encodeFunctionData("balanceOf", [bob.address]),
      },
    ];

    const results = await multicall.aggregate3.staticCall(calls);

    expect(results[0].success).to.equal(true);
    expect(results[1].success).to.equal(true);

    const bobBal = erc20Iface.decodeFunctionResult(
      "balanceOf",
      results[1].returnData
    )[0];
    expect(bobBal).to.equal(2500n);
  });
});
