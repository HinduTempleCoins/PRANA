const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

const { buildEconomy, checkConservation, mulberry32 } = require("../lib/faucet-sink");

// ---------------------------------------------------------------------------
// FaucetSink conservation — every emission of the reward token (POL) is paired
// with a sink, so over any activity window:
//
//     sum(faucet.totalEmitted) - sum(sink.totalAbsorbed) == POL.totalSupply - supply0
//
// Wiring (all on the SAME reward token, PoLToken):
//   FAUCET: DelegationMint.claim()  -> MINTS POL to the claimer (MINTER_ROLE).
//   SINK:   BurnMine.mine()         -> input token = POL (BURNED), output = a separate
//                                      MockERC20 ("rare"). So POL leaves supply here.
//
// DelegationMint has no cumulative-minted getter, so the harness measures emissions by
// diffing POL.totalSupply across each claim (a real mint event). BurnMine.totalBurned()
// is its own getter and equals POL burned (input==POL, ratio 1:1 in burned units).
// ---------------------------------------------------------------------------
describe("FaucetSink — POL conservation (DelegationMint faucet + BurnMine sink)", function () {
  async function deployFixture() {
    const [admin, ...rest] = await ethers.getSigners();
    const users = rest.slice(0, 4);

    // Reward token whose supply we conserve.
    const PoL = await ethers.getContractFactory("PoLToken");
    const pol = await PoL.deploy(admin.address);

    // Stake token for DelegationMint (anything ERC-20 will do).
    const Mock = await ethers.getContractFactory("MockERC20");
    const stake = await Mock.deploy("Stake", "STK");

    // Output token for the BurnMine sink (the "rare" minted token — NOT POL).
    const rare = await Mock.deploy("Rare", "RARE");

    // FAUCET: emits 100 POL per block, pro-rata to delegated stake.
    const EMISSION = 100n;
    const DM = await ethers.getContractFactory("DelegationMint");
    const dm = await DM.deploy(await stake.getAddress(), await pol.getAddress(), EMISSION);
    await pol.grantRole(await pol.MINTER_ROLE(), await dm.getAddress());

    // SINK: BurnMine burns POL (input) at 2:5 ratio into `rare`. POL leaves supply.
    const RATIO_NUM = 2n;
    const RATIO_DEN = 5n;
    const Mine = await ethers.getContractFactory("BurnMine");
    const mineC = await Mine.deploy(
      await pol.getAddress(), // input == POL  => POL is the burned (sunk) token
      await rare.getAddress(),
      RATIO_NUM,
      RATIO_DEN
    );
    // BurnMine must be able to mint the output token. MockERC20.mint is open, but the
    // BurnMine calls output.mint(...) — MockERC20 exposes a public mint, so it works.

    // Fund users with stake + approve DelegationMint; approve BurnMine to pull POL.
    for (const u of users) {
      await stake.mint(u.address, 1_000_000n);
      await stake.connect(u).approve(await dm.getAddress(), ethers.MaxUint256);
      await pol.connect(u).approve(await mineC.getAddress(), ethers.MaxUint256);
    }

    const supply0 = BigInt(await pol.totalSupply()); // 0 — PoLToken has no premine

    return { admin, users, pol, stake, rare, dm, mineC, EMISSION, RATIO_NUM, RATIO_DEN, supply0 };
  }

  it("net POL supply delta == emitted(DelegationMint) - burned(BurnMine), over a seeded random sequence", async () => {
    const { users, pol, dm, mineC, supply0 } = await loadFixture(deployFixture);
    const rng = mulberry32(0x9a1c0de);

    // Harness-measured emission accumulator for DelegationMint (no on-chain getter):
    // sum of POL minted across all claim() calls, measured by supply diff.
    let measuredEmitted = 0n;

    // Build the economy: one faucet (measured), one sink (getter).
    const economy = buildEconomy({
      rewardToken: pol,
      supply0,
      faucets: [{ name: "DelegationMint", measured: () => measuredEmitted }],
      sinks: [{ name: "BurnMine", contract: mineC, getter: "totalBurned" }],
    });

    // Seed: everyone delegates a little so emission has somewhere to go.
    for (const u of users) {
      await dm.connect(u).delegate(BigInt(1000 + Math.floor(rng() * 4000)));
    }

    for (let step = 0; step < 140; step++) {
      const u = users[Math.floor(rng() * users.length)];
      const op = Math.floor(rng() * 5);

      if (op === 0) {
        // delegate more stake
        await dm.connect(u).delegate(BigInt(1 + Math.floor(rng() * 3000)));
      } else if (op === 1) {
        // undelegate part of the stake
        const cur = await dm.delegatedOf(u.address);
        if (cur > 0n) {
          const amt = 1n + (BigInt(Math.floor(rng() * 1_000_000)) % cur);
          await dm.connect(u).undelegate(amt);
        }
      } else if (op === 2) {
        // CLAIM -> faucet mints POL. Measure the exact mint by supply diff.
        const before = BigInt(await pol.totalSupply());
        await dm.connect(u).claim();
        const after = BigInt(await pol.totalSupply());
        measuredEmitted += after - before; // >= 0; claim mints only the accrued reward
      } else if (op === 3) {
        // SINK: burn POL via BurnMine.mine() if the user holds enough to produce out>0.
        const bal = BigInt(await pol.balanceOf(u.address));
        // need amountIn s.t. quote(amountIn) = amountIn*2/5 > 0  =>  amountIn >= 3.
        if (bal >= 3n) {
          const amountIn = 3n + (BigInt(Math.floor(rng() * 100000)) % (bal - 2n));
          await mineC.connect(u).mine(amountIn);
        }
      } else {
        // advance blocks so emission accrues
        await mine(1 + Math.floor(rng() * 6));
      }

      // ---- CONSERVATION INVARIANT after every step ----
      const { emitted, absorbed, supplyDelta, residual } = await checkConservation(economy);
      expect(residual).to.equal(0n);
      // emitted and absorbed are each non-negative and monotonic in spirit:
      expect(emitted).to.be.gte(0n);
      expect(absorbed).to.be.gte(0n);
      // net delta equals emitted minus absorbed exactly (the identity, restated).
      expect(supplyDelta).to.equal(emitted - absorbed);
    }

    // Final: drain all pending claims, then re-check exact conservation once more.
    for (const u of users) {
      const before = BigInt(await pol.totalSupply());
      await dm.connect(u).claim();
      measuredEmitted += BigInt(await pol.totalSupply()) - before;
    }
    const final = await checkConservation(economy);
    expect(final.residual).to.equal(0n);

    // Cross-check the measured faucet total against the only other POL movements:
    // total minted (emitted) - total burned (absorbed) must equal live supply.
    expect(final.emitted - final.absorbed).to.equal(BigInt(await pol.totalSupply()) - supply0);
    // And the sink genuinely removed POL: if anything was burned, supply < emitted.
    if (final.absorbed > 0n) {
      expect(final.emitted).to.be.gt(BigInt(await pol.totalSupply()));
    }
  });
});
