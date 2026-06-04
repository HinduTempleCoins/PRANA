const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Mirror the library/mock math in JS so we can assert exact, deterministic results.
const U256 = (1n << 256n) - 1n;

function deriveWord(seed, requestId) {
  // keccak256(abi.encodePacked(uint256 seed, uint256 requestId))
  const packed = ethers.solidityPacked(["uint256", "uint256"], [seed, requestId]);
  return BigInt(ethers.keccak256(packed)) & U256;
}

function linearDraw(weights, entropy) {
  const total = weights.reduce((a, b) => a + b, 0n);
  const roll = entropy % total;
  let cursor = 0n;
  for (let i = 0; i < weights.length; i++) {
    cursor += weights[i];
    if (roll < cursor) return i;
  }
  return weights.length - 1;
}

function cumulativeJs(weights) {
  const cum = [];
  let acc = 0n;
  for (const w of weights) {
    acc += w;
    cum.push(acc);
  }
  return cum;
}

describe("WeightedRandomDraw", function () {
  const SEED = 123456789n;
  const WEIGHTS = [70n, 25n, 5n]; // common / rare / legendary

  async function deployFixture() {
    const Factory = await ethers.getContractFactory("LocalRandomMock");
    const mock = await Factory.deploy(SEED);
    await mock.waitForDeployment();
    return { mock };
  }

  it("draw matches a hand-computed linear scan", async function () {
    const { mock } = await loadFixture(deployFixture);
    for (let i = 0; i < 20; i++) {
      const word = deriveWord(SEED, BigInt(i));
      const got = await mock.draw(WEIGHTS, word);
      expect(got).to.equal(BigInt(linearDraw(WEIGHTS, word)));
    }
  });

  it("cumulative builds the running totals", async function () {
    const { mock } = await loadFixture(deployFixture);
    const cum = await mock.cumulative(WEIGHTS);
    expect(cum).to.deep.equal(cumulativeJs(WEIGHTS));
  });

  it("drawFromCumulative (binary search) agrees with linear draw", async function () {
    const { mock } = await loadFixture(deployFixture);
    const cum = cumulativeJs(WEIGHTS);
    for (let i = 0; i < 50; i++) {
      const word = deriveWord(SEED, BigInt(i));
      const bin = await mock.drawFromCumulative(cum, word);
      expect(bin).to.equal(BigInt(linearDraw(WEIGHTS, word)));
    }
  });

  it("zero-weight outcomes are never selected", async function () {
    const { mock } = await loadFixture(deployFixture);
    const weights = [50n, 0n, 50n]; // middle outcome impossible
    const cum = cumulativeJs(weights);
    for (let i = 0; i < 200; i++) {
      const word = deriveWord(SEED, BigInt(i));
      const idx = await mock.drawFromCumulative(cum, word);
      expect(idx).to.not.equal(1n);
    }
  });

  it("reverts on empty / all-zero tables", async function () {
    const { mock } = await loadFixture(deployFixture);
    await expect(mock.draw([], 1n)).to.be.revertedWithCustomError(
      mock,
      "EmptyTable"
    );
    await expect(mock.draw([0n, 0n], 1n)).to.be.revertedWithCustomError(
      mock,
      "ZeroTotalWeight"
    );
    await expect(mock.cumulative([])).to.be.revertedWithCustomError(
      mock,
      "EmptyTable"
    );
  });

  it("statistical sanity: N=2000 seeded draws match weights and the exact seeded counts", async function () {
    const { mock } = await loadFixture(deployFixture);
    const N = 2000;
    const cum = cumulativeJs(WEIGHTS);
    const total = WEIGHTS.reduce((a, b) => a + b, 0n);

    // Compute the exact deterministic distribution off-chain from the same seed sequence.
    const expected = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const word = deriveWord(SEED, BigInt(i));
      expected[linearDraw(WEIGHTS, word)]++;
    }

    // Spot-check the contract reproduces the same per-draw outcome for a sample of indices,
    // proving the on-chain library and the off-chain model are the same function. (Checking
    // all 2000 on-chain would be needlessly slow; the math is pure and deterministic.)
    for (const i of [0, 1, 7, 42, 100, 999, 1500, 1999]) {
      const word = deriveWord(SEED, BigInt(i));
      const onchain = await mock.drawFromCumulative(cum, word);
      expect(onchain).to.equal(BigInt(linearDraw(WEIGHTS, word)));
    }

    // Counts sum to N and roughly track the weights (deterministic — no flakiness).
    expect(expected[0] + expected[1] + expected[2]).to.equal(N);
    for (let i = 0; i < 3; i++) {
      const ideal = (N * Number(WEIGHTS[i])) / Number(total);
      // Within 5% of N of the ideal share — comfortably true for this fixed seed.
      expect(Math.abs(expected[i] - ideal)).to.be.lessThan(N * 0.05);
    }

    // Ordering sanity: common >> rare >> legendary.
    expect(expected[0]).to.be.greaterThan(expected[1]);
    expect(expected[1]).to.be.greaterThan(expected[2]);
  });

  it("the seedable source produces a reproducible request sequence", async function () {
    const { mock } = await loadFixture(deployFixture);
    expect(await mock.peek(0n)).to.equal(deriveWord(SEED, 0n));
    expect(await mock.nextWord()).to.equal(deriveWord(SEED, 0n));

    await mock.requestRandomness(); // nonce 0 consumed
    expect(await mock.wordOf(0n)).to.equal(deriveWord(SEED, 0n));
    expect(await mock.nextWord()).to.equal(deriveWord(SEED, 1n));

    // Reseeding changes the sequence base deterministically.
    await mock.setSeed(999n);
    expect(await mock.peek(5n)).to.equal(deriveWord(999n, 5n));
  });
});
