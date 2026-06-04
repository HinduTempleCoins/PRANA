const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Deterministic pseudo-random generator (mulberry32) so runs are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("BurnMine — invariants", function () {
  // ratio = ratioNum / ratioDen, deliberately varied to exercise floor rounding.
  async function deployFixture() {
    const [admin, ...users] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const input = await Mock.deploy("Input", "IN");

    const PoL = await ethers.getContractFactory("PoLToken");
    const output = await PoL.deploy(admin.address);

    const RATIO_NUM = 3n;
    const RATIO_DEN = 7n; // non-divisible ratio forces floor rounding on most inputs

    const Mine = await ethers.getContractFactory("BurnMine");
    const mine = await Mine.deploy(
      await input.getAddress(),
      await output.getAddress(),
      RATIO_NUM,
      RATIO_DEN
    );

    await output.grantRole(await output.MINTER_ROLE(), await mine.getAddress());

    // Fund a handful of users generously with input tokens.
    for (const u of users.slice(0, 5)) {
      await input.mint(u.address, 10_000_000n);
      await input.connect(u).approve(await mine.getAddress(), ethers.MaxUint256);
    }

    return { input, output, mine, admin, users: users.slice(0, 5), RATIO_NUM, RATIO_DEN };
  }

  it("total output minted <= ratio * total input burned (floored), across randomized burn sequences", async () => {
    const { input, output, mine, users, RATIO_NUM, RATIO_DEN } = await loadFixture(deployFixture);
    const rng = makeRng(0xa11ce);

    let expectedBurned = 0n;
    let expectedMinted = 0n;

    for (let i = 0; i < 120; i++) {
      const u = users[Math.floor(rng() * users.length)];
      const amountIn = BigInt(1 + Math.floor(rng() * 5000));
      const out = (amountIn * RATIO_NUM) / RATIO_DEN;
      if (out === 0n) {
        // contract rejects rounds-to-zero; assert and skip
        await expect(mine.connect(u).mine(amountIn)).to.be.revertedWith("out=0");
        continue;
      }

      await mine.connect(u).mine(amountIn);
      expectedBurned += amountIn;
      expectedMinted += out;

      // Core invariant: minted is the floored ratio of burned, hence minted*den <= burned*num.
      expect(await mine.totalMinted()).to.equal(expectedMinted);
      expect(await mine.totalBurned()).to.equal(expectedBurned);
      expect((await mine.totalMinted()) * RATIO_DEN).to.be.lte((await mine.totalBurned()) * RATIO_NUM);

      // Output supply equals everything ever minted (no other minter path is exercised).
      expect(await output.totalSupply()).to.equal(expectedMinted);
    }
  });

  it("burning strictly reduces the input token totalSupply (true sink, no dead-address holding)", async () => {
    const { input, mine, users, RATIO_DEN } = await loadFixture(deployFixture);
    const rng = makeRng(0xb0b);

    let supply = await input.totalSupply();
    const mineAddr = await mine.getAddress();

    for (let i = 0; i < 80; i++) {
      const u = users[Math.floor(rng() * users.length)];
      // ensure output rounds up to >=1 so the call succeeds
      const amountIn = BigInt(Number(RATIO_DEN) + Math.floor(rng() * 5000));

      const before = await input.totalSupply();
      await mine.connect(u).mine(amountIn);
      const after = await input.totalSupply();

      // input supply went down by exactly amountIn — the mine does not stockpile it.
      expect(after).to.equal(before - amountIn);
      expect(await input.balanceOf(mineAddr)).to.equal(0n);
      supply = after;
    }

    expect(await input.totalSupply()).to.equal(supply);
  });

  it("no mint path exists without a paired burn: output supply <= floored ratio of cumulative burns", async () => {
    const { input, output, mine, users, RATIO_NUM, RATIO_DEN } = await loadFixture(deployFixture);
    const rng = makeRng(0xcafe);

    for (let i = 0; i < 100; i++) {
      const u = users[Math.floor(rng() * users.length)];
      const amountIn = BigInt(1 + Math.floor(rng() * 4000));
      const out = (amountIn * RATIO_NUM) / RATIO_DEN;
      if (out === 0n) continue;

      const outSupplyBefore = await output.totalSupply();
      const burnedBefore = await mine.totalBurned();

      await mine.connect(u).mine(amountIn);

      // Every unit of new output supply is backed by a strictly positive burn this call.
      expect((await output.totalSupply()) - outSupplyBefore).to.equal(out);
      expect((await mine.totalBurned()) - burnedBefore).to.equal(amountIn);
      expect(amountIn).to.be.gt(0n);

      // Cumulative: output supply can never exceed the floored ratio of all burns.
      const maxAllowed = ((await mine.totalBurned()) * RATIO_NUM) / RATIO_DEN;
      expect(await output.totalSupply()).to.be.lte(maxAllowed);
    }
  });
});
