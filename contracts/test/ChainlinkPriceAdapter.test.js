const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const MAX_STALENESS = 3600n; // 1 hour

describe("ChainlinkPriceAdapter", function () {
  let token, feed, adapter;

  async function now() {
    return BigInt(await time.latest());
  }

  beforeEach(async () => {
    token = ethers.Wallet.createRandom().address;
  });

  it("returns the feed answer scaled to 1e18 (8-decimal feed)", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    // 8-decimal feed reporting $2000.00000000
    feed = await Mock.deploy(8, 2000n * 10n ** 8n, await now());
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = await Adapter.deploy([token], [await feed.getAddress()], [MAX_STALENESS]);

    expect(await adapter.price(token)).to.equal(2000n * WAD);
  });

  it("scales decimals correctly for a non-8 feed (18-decimal passthrough, 20-decimal down-scale)", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");

    // 18-decimal feed -> passthrough
    const f18 = await Mock.deploy(18, 5n * WAD, await now());
    const a18 = await Adapter.deploy([token], [await f18.getAddress()], [MAX_STALENESS]);
    expect(await a18.price(token)).to.equal(5n * WAD);

    // 20-decimal feed -> down-scaled
    const f20 = await Mock.deploy(20, 7n * 10n ** 20n, await now());
    const a20 = await Adapter.deploy([token], [await f20.getAddress()], [MAX_STALENESS]);
    expect(await a20.price(token)).to.equal(7n * WAD);
  });

  it("reverts on stale data once maxStaleness is exceeded", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    feed = await Mock.deploy(8, 1500n * 10n ** 8n, await now());
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = await Adapter.deploy([token], [await feed.getAddress()], [MAX_STALENESS]);

    // fresh -> ok
    expect(await adapter.price(token)).to.equal(1500n * WAD);

    // advance past the staleness window
    await time.increase(MAX_STALENESS + 1n);
    await expect(adapter.price(token)).to.be.revertedWith("stale price");
  });

  it("reverts on a non-positive answer", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    feed = await Mock.deploy(8, 0, await now());
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = await Adapter.deploy([token], [await feed.getAddress()], [MAX_STALENESS]);

    await expect(adapter.price(token)).to.be.revertedWith("bad answer");

    // also negative
    await feed.setAnswer(-1, await now());
    await expect(adapter.price(token)).to.be.revertedWith("bad answer");
  });

  it("reverts on an incomplete round", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    feed = await Mock.deploy(8, 1000n * 10n ** 8n, await now());
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = await Adapter.deploy([token], [await feed.getAddress()], [MAX_STALENESS]);

    await feed.setIncompleteRound();
    await expect(adapter.price(token)).to.be.revertedWith("incomplete round");
  });

  it("reverts for an unregistered token", async () => {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    feed = await Mock.deploy(8, 1000n * 10n ** 8n, await now());
    const Adapter = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = await Adapter.deploy([token], [await feed.getAddress()], [MAX_STALENESS]);

    const other = ethers.Wallet.createRandom().address;
    await expect(adapter.price(other)).to.be.revertedWith("unknown token");
  });
});
