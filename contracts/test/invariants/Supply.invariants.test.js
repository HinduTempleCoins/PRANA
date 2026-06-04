const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

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

describe("Supply (ERC20Base + SupplyController) — invariants", function () {
  const CAP = 1_000_000n;

  async function baseFixture() {
    const [admin, ...users] = await ethers.getSigners();
    const T = await ethers.getContractFactory("ERC20Base");
    const token = await T.deploy("Base", "BASE", CAP, admin.address);
    return { token, admin, users: users.slice(0, 5) };
  }

  it("totalSupply never exceeds the cap regardless of mint/burn/transfer order", async () => {
    const { token, admin, users } = await loadFixture(baseFixture);
    const rng = makeRng(0xfeed);

    for (let i = 0; i < 200; i++) {
      const op = Math.floor(rng() * 3);
      const u = users[Math.floor(rng() * users.length)];

      if (op === 0) {
        // mint: attempt an amount that may or may not exceed cap
        const remaining = CAP - (await token.totalSupply());
        // sometimes deliberately overshoot to confirm the cap holds
        const amount = BigInt(Math.floor(rng() * Number(CAP) / 4));
        if (amount === 0n) continue;
        if (amount <= remaining) {
          await token.mint(u.address, amount);
        } else {
          await expect(token.mint(u.address, amount)).to.be.reverted; // ERC20ExceededCap
        }
      } else if (op === 1) {
        // burn from a user that holds something
        const bal = await token.balanceOf(u.address);
        if (bal > 0n) {
          const amount = BigInt(Math.floor(rng() * Number(bal)));
          if (amount > 0n) await token.connect(u).burn(amount);
        }
      } else {
        // transfer between two users
        const v = users[Math.floor(rng() * users.length)];
        const bal = await token.balanceOf(u.address);
        if (bal > 0n) {
          const amount = BigInt(Math.floor(rng() * Number(bal)));
          if (amount > 0n) await token.connect(u).transfer(v.address, amount);
        }
      }

      // The invariant under every reachable state.
      expect(await token.totalSupply()).to.be.lte(CAP);
    }
  });

  it("burning then re-minting can never push past the cap (burns do not raise the ceiling)", async () => {
    const { token, admin, users } = await loadFixture(baseFixture);
    // Fill to the cap.
    await token.mint(users[0].address, CAP);
    expect(await token.totalSupply()).to.equal(CAP);
    await expect(token.mint(users[0].address, 1n)).to.be.reverted;

    // Burn some, then the freed headroom equals exactly what was burned — not more.
    await token.connect(users[0]).burn(500n);
    expect(await token.totalSupply()).to.equal(CAP - 500n);
    await token.mint(users[1].address, 500n);
    await expect(token.mint(users[1].address, 1n)).to.be.reverted;
    expect(await token.totalSupply()).to.equal(CAP);
  });

  it("SupplyController: per-epoch emission never exceeds the hard cap, over many randomized mints", async () => {
    const [admin, ...rest] = await ethers.getSigners();
    const users = rest.slice(0, 4);
    const PoL = await ethers.getContractFactory("PoLToken");
    const token = await PoL.deploy(admin.address);
    const PER_EPOCH = 1000n;
    const EPOCH = 100;
    const SC = await ethers.getContractFactory("SupplyController");
    const ctrl = await SC.deploy(await token.getAddress(), PER_EPOCH, EPOCH, admin.address);
    await token.grantRole(await token.MINTER_ROLE(), await ctrl.getAddress());

    const rng = makeRng(0x1234);

    for (let epoch = 0; epoch < 6; epoch++) {
      let mintedThisEpoch = 0n;
      const e = await ctrl.currentEpoch();

      for (let k = 0; k < 12; k++) {
        const u = users[Math.floor(rng() * users.length)];
        const amount = BigInt(1 + Math.floor(rng() * 400));
        const remaining = PER_EPOCH - mintedThisEpoch;

        if (amount <= remaining) {
          await ctrl.mintCapped(u.address, amount);
          mintedThisEpoch += amount;
        } else {
          await expect(ctrl.mintCapped(u.address, amount)).to.be.revertedWith("epoch cap");
        }

        // Invariant: minted in this epoch never exceeds the per-epoch hard cap.
        expect(await ctrl.mintedInEpoch(e)).to.be.lte(PER_EPOCH);
        expect(await ctrl.mintedInEpoch(e)).to.equal(mintedThisEpoch);
      }

      await time.increase(EPOCH + 1); // advance to a fresh epoch; cap resets
    }
  });

  it("pausing blocks transfers and mints; unpausing restores them", async () => {
    const { token, admin, users } = await loadFixture(baseFixture);
    await token.mint(users[0].address, 1000n);
    await token.pause();

    await expect(token.connect(users[0]).transfer(users[1].address, 1n)).to.be.reverted;
    await expect(token.mint(users[0].address, 1n)).to.be.reverted;
    await expect(token.connect(users[0]).burn(1n)).to.be.reverted;

    await token.unpause();
    await token.connect(users[0]).transfer(users[1].address, 10n);
    await token.mint(users[0].address, 10n);
    expect(await token.balanceOf(users[1].address)).to.equal(10n);
  });
});
