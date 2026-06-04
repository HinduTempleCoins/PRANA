const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// XX6 — BurnStakeRegistry invariant suite (Proof-of-Burn PERMA-stake; NO exit ever).
//
// Encoded invariants:
//   (a) weightOf is MONOTONIC NON-DECREASING per account — burns only ever ADD; no function on the
//       contract reduces weightOf for any account, at any time, for any caller.
//   (b) totalWeight == sum of all per-account weights, at all times (after every credit).
//   (c) NO exit path — there is no withdraw/unstake/exit/refund/unlock/decrease/slash function in the
//       ABI, and the principal is provably destroyed (PRANA totalSupply drops; nothing pools in the
//       registry). Any plausible "unstake" call therefore does not exist (selector absent → reverts).
//   (d) recordBurnWeight is role-gated to BURNER_ROLE.
//
// Deterministic pseudo-random generator (mulberry32) so randomized sequences are reproducible.
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

describe("BurnStakeRegistry — invariants (Proof-of-Burn perma-stake)", function () {
  async function deployFixture() {
    const [admin, router, ...users] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA"); // ERC20 + ERC20Burnable
    const other = await Mock.deploy("Other", "OTH");

    const Reg = await ethers.getContractFactory("BurnStakeRegistry");
    const registry = await Reg.deploy(await prana.getAddress(), admin.address);

    const BURNER_ROLE = await registry.BURNER_ROLE();
    await registry.connect(admin).grantRole(BURNER_ROLE, router.address);

    const actors = users.slice(0, 5);
    for (const u of actors) {
      await prana.mint(u.address, ethers.parseEther("1000000"));
      await prana.connect(u).approve(await registry.getAddress(), ethers.MaxUint256);
    }

    return { admin, router, actors, prana, other, registry, BURNER_ROLE };
  }

  it("(a)+(b) weight is monotonic non-decreasing per account, and totalWeight == sum, across randomized burn/credit sequences", async () => {
    const { router, actors, prana, other, registry } = await loadFixture(deployFixture);
    const rng = makeRng(0xb0bcafe);

    // Local model of expected per-account weight; verified against the contract after each op.
    const model = new Map(actors.map((a) => [a.address, 0n]));
    const prevWeight = new Map(actors.map((a) => [a.address, 0n]));

    for (let i = 0; i < 200; i++) {
      const u = actors[Math.floor(rng() * actors.length)];
      const viaRouter = rng() < 0.5;

      let added;
      if (viaRouter) {
        // Router credits an arbitrary normalized weight for an already-burned cross-currency amount.
        const amount = BigInt(1 + Math.floor(rng() * 100000));
        added = BigInt(1 + Math.floor(rng() * 100000)); // weightAdded (router-normalized, >0)
        await registry
          .connect(router)
          .recordBurnWeight(u.address, await other.getAddress(), amount, added);
      } else {
        // burnPrana: pull+burn native PRANA, self-credit 1:1.
        added = BigInt(1 + Math.floor(rng() * 100000));
        await registry.connect(u).burnPrana(added);
      }

      model.set(u.address, model.get(u.address) + added);

      // (a) Monotonic: every account's weightOf is >= its previously-recorded value (never debited)
      //     and equals the running model (only ever increased). Then snapshot for the next round.
      for (const a of actors) {
        const w = await registry.weightOf(a.address);
        expect(w).to.be.gte(prevWeight.get(a.address));
        expect(w).to.equal(model.get(a.address));
        prevWeight.set(a.address, w);
      }

      // (b) totalWeight == sum of all per-account weights.
      let sum = 0n;
      for (const v of model.values()) sum += v;
      expect(await registry.totalWeight()).to.equal(sum);
    }
  });

  it("(a) no operation by any caller ever reduces an account's weight (idle blocks / foreign burns don't debit)", async () => {
    const { router, actors, prana, other, registry } = await loadFixture(deployFixture);
    const [alice, bob] = actors;

    await registry.connect(alice).burnPrana(ethers.parseEther("123"));
    const wAlice = await registry.weightOf(alice.address);

    // Mining empty blocks doesn't change weight.
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.weightOf(alice.address)).to.equal(wAlice);

    // Another account burning / being credited cannot reduce Alice's weight.
    await registry.connect(bob).burnPrana(ethers.parseEther("9"));
    await registry
      .connect(router)
      .recordBurnWeight(bob.address, await other.getAddress(), 1n, 5n);
    expect(await registry.weightOf(alice.address)).to.equal(wAlice);

    // Alice burning more only increases hers.
    await registry.connect(alice).burnPrana(1n);
    expect(await registry.weightOf(alice.address)).to.equal(wAlice + 1n);
  });

  it("(c) NO-EXIT: the ABI exposes no withdraw/unstake/exit/refund/unlock/decrease/slash path", async () => {
    const { registry } = await loadFixture(deployFixture);
    const fnNames = registry.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());

    for (const banned of [
      "withdraw",
      "unstake",
      "exit",
      "refund",
      "unlock",
      "decrease",
      "slash",
      "redeem",
      "release",
      "debit",
    ]) {
      expect(
        fnNames.some((n) => n.includes(banned)),
        `unexpected exit-like function containing "${banned}"`
      ).to.equal(false);
    }

    // There is NO writer of weight other than recordBurnWeight / burnPrana → and neither decreases it.
    // Exclude read-only getters that merely contain "weight": totalWeight and the weightHook getter
    // (the public-var accessor of the configured hook address — a view, not a mutator).
    const writers = fnNames.filter(
      (n) => n.includes("weight") && !n.startsWith("weightof") && n !== "totalweight" && n !== "weighthook"
    );
    // The only weight-touching externally-callable name is recordBurnWeight (+ setWeightHook wiring).
    expect(writers.every((n) => n === "recordburnweight" || n === "setweighthook")).to.equal(true);
  });

  it("(c) the burn is irreversible: PRANA principal is destroyed (totalSupply drops) and nothing pools in the registry", async () => {
    const { actors, prana, registry } = await loadFixture(deployFixture);
    const [alice] = actors;

    const supply0 = await prana.totalSupply();
    const bal0 = await prana.balanceOf(alice.address);
    const amt = ethers.parseEther("777");

    await registry.connect(alice).burnPrana(amt);

    // Principal provably gone — not merely transferred to the registry.
    expect(await prana.totalSupply()).to.equal(supply0 - amt);
    expect(await prana.balanceOf(alice.address)).to.equal(bal0 - amt);
    expect(await prana.balanceOf(await registry.getAddress())).to.equal(0n);

    // The credited weight is a forever ledger entry — there is no way to send the principal back.
    expect(await registry.weightOf(alice.address)).to.equal(amt);
  });

  it("(d) recordBurnWeight is BURNER_ROLE-gated; non-holders revert, the granted router succeeds", async () => {
    const { admin, router, actors, other, registry, BURNER_ROLE } = await loadFixture(deployFixture);
    const [alice, bob] = actors;

    // A non-holder (alice) cannot credit weight to anyone.
    await expect(
      registry.connect(alice).recordBurnWeight(bob.address, await other.getAddress(), 1n, 100n)
    ).to.be.reverted;
    // Even the admin (DEFAULT_ADMIN_ROLE / ADMIN_ROLE) lacks BURNER_ROLE and cannot credit.
    await expect(
      registry.connect(admin).recordBurnWeight(bob.address, await other.getAddress(), 1n, 100n)
    ).to.be.reverted;

    // The granted router can.
    await registry
      .connect(router)
      .recordBurnWeight(bob.address, await other.getAddress(), 1n, 100n);
    expect(await registry.weightOf(bob.address)).to.equal(100n);

    // Revoking the role re-closes the door.
    await registry.connect(admin).revokeRole(BURNER_ROLE, router.address);
    await expect(
      registry.connect(router).recordBurnWeight(bob.address, await other.getAddress(), 1n, 1n)
    ).to.be.reverted;
  });

  it("(d) wiring setters (setWeightHook/setReceiptLedger) are ADMIN_ROLE-gated", async () => {
    const { actors, registry } = await loadFixture(deployFixture);
    const [alice] = actors;
    await expect(registry.connect(alice).setWeightHook(ethers.ZeroAddress)).to.be.reverted;
    await expect(registry.connect(alice).setReceiptLedger(ethers.ZeroAddress)).to.be.reverted;
  });

  it("zero-value credits are rejected (no phantom weight, fail-closed)", async () => {
    const { router, actors, other, registry } = await loadFixture(deployFixture);
    const [alice] = actors;
    await expect(registry.connect(alice).burnPrana(0)).to.be.revertedWithCustomError(
      registry,
      "ZeroAmount"
    );
    await expect(
      registry.connect(router).recordBurnWeight(alice.address, await other.getAddress(), 1n, 0n)
    ).to.be.revertedWithCustomError(registry, "ZeroAmount");
    await expect(
      registry
        .connect(router)
        .recordBurnWeight(ethers.ZeroAddress, await other.getAddress(), 1n, 1n)
    ).to.be.revertedWithCustomError(registry, "ZeroAddress");
  });
});
