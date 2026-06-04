const { expect } = require("chai");
const { ethers } = require("hardhat");

// BurnStakeRegistry (OO1) + BurnStakeGovernanceAdapter (OO2).
// Verifies: permanent (monotonic, never-decreasing) weight; the no-withdraw / no-exit invariant
// (there is literally no function that returns principal or reduces weight); multi-account
// totalWeight; native burnPrana actually reduces PRANA total supply; and IVotes getPastVotes via
// checkpoints (auto-checkpoint hook + manual catch-up).
describe("BurnStakeRegistry + BurnStakeGovernanceAdapter", function () {
  let prana, other, registry, adapter;
  let admin, router, alice, bob;
  let BURNER_ROLE;

  beforeEach(async () => {
    [admin, router, alice, bob] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    prana = await Mock.deploy("Prana", "PRANA"); // ERC20 + ERC20Burnable
    other = await Mock.deploy("Other", "OTH");

    const Reg = await ethers.getContractFactory("BurnStakeRegistry");
    registry = await Reg.deploy(await prana.getAddress(), admin.address);

    const Adapter = await ethers.getContractFactory("BurnStakeGovernanceAdapter");
    adapter = await Adapter.deploy(await registry.getAddress());

    // wire the auto-checkpoint hook + grant the router the BURNER_ROLE
    await registry.connect(admin).setWeightHook(await adapter.getAddress());
    BURNER_ROLE = await registry.BURNER_ROLE();
    await registry.connect(admin).grantRole(BURNER_ROLE, router.address);

    // fund + approve burnPrana users
    for (const u of [alice, bob]) {
      await prana.mint(u.address, ethers.parseEther("1000"));
      await prana.connect(u).approve(await registry.getAddress(), ethers.MaxUint256);
    }
  });

  it("burnPrana burns 1:1, reduces PRANA total supply, and credits permanent weight", async () => {
    const supply0 = await prana.totalSupply();
    const amt = ethers.parseEther("100");

    await expect(registry.connect(alice).burnPrana(amt))
      .to.emit(registry, "Burned")
      .withArgs(alice.address, await prana.getAddress(), amt, amt);

    expect(await prana.totalSupply()).to.equal(supply0 - amt); // principal destroyed
    expect(await registry.weightOf(alice.address)).to.equal(amt);
    expect(await registry.totalWeight()).to.equal(amt);
    // user's PRANA balance was pulled and burned
    expect(await prana.balanceOf(alice.address)).to.equal(ethers.parseEther("900"));
    // nothing stuck in the registry
    expect(await prana.balanceOf(await registry.getAddress())).to.equal(0n);
  });

  it("weight is MONOTONIC — successive burns only ever increase it, never decrease", async () => {
    await registry.connect(alice).burnPrana(ethers.parseEther("10"));
    const w1 = await registry.weightOf(alice.address);
    await registry.connect(alice).burnPrana(ethers.parseEther("5"));
    const w2 = await registry.weightOf(alice.address);
    expect(w2).to.equal(w1 + ethers.parseEther("5"));
    expect(w2).to.be.greaterThan(w1);
  });

  it("NO-EXIT invariant: the registry exposes no withdraw / unstake / decrease path", async () => {
    // There is no withdraw/unstake/exit/refund function on the ABI at all.
    const fnNames = registry.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    for (const banned of ["withdraw", "unstake", "exit", "refund", "unlock", "decrease", "slash"]) {
      expect(fnNames.some((n) => n.includes(banned))).to.equal(false);
    }
    // And weight cannot be reduced through any path: after burning, it stays put.
    await registry.connect(alice).burnPrana(ethers.parseEther("42"));
    const w = await registry.weightOf(alice.address);
    // mine some blocks / nothing reduces it
    await ethers.provider.send("evm_mine", []);
    expect(await registry.weightOf(alice.address)).to.equal(w);
  });

  it("recordBurnWeight is BURNER-gated; router can credit normalized cross-currency weight", async () => {
    const amt = 1234n;
    const weight = 9999n; // router-normalized
    await expect(
      registry.connect(alice).recordBurnWeight(alice.address, await other.getAddress(), amt, weight)
    ).to.be.reverted; // not a burner

    await expect(
      registry.connect(router).recordBurnWeight(bob.address, await other.getAddress(), amt, weight)
    )
      .to.emit(registry, "Burned")
      .withArgs(bob.address, await other.getAddress(), amt, weight);

    expect(await registry.weightOf(bob.address)).to.equal(weight);
  });

  it("multi-account totalWeight is the sum of all accounts' permanent weight", async () => {
    await registry.connect(alice).burnPrana(ethers.parseEther("30"));
    await registry.connect(bob).burnPrana(ethers.parseEther("70"));
    await registry.connect(router).recordBurnWeight(admin.address, await other.getAddress(), 1n, 100n);

    expect(await registry.totalWeight()).to.equal(ethers.parseEther("100") + 100n);
  });

  it("reverts on zero amounts / zero account", async () => {
    await expect(registry.connect(alice).burnPrana(0)).to.be.revertedWithCustomError(
      registry,
      "ZeroAmount"
    );
    await expect(
      registry.connect(router).recordBurnWeight(alice.address, await other.getAddress(), 1n, 0n)
    ).to.be.revertedWithCustomError(registry, "ZeroAmount");
    await expect(
      registry.connect(router).recordBurnWeight(ethers.ZeroAddress, await other.getAddress(), 1n, 1n)
    ).to.be.revertedWithCustomError(registry, "ZeroAddress");
  });

  describe("governance adapter (IVotes) getPastVotes via checkpoints", function () {
    it("auto-checkpoints on burn so getPastVotes reflects weight at the burn block", async () => {
      await registry.connect(alice).burnPrana(ethers.parseEther("40"));
      const blk1 = await ethers.provider.getBlockNumber();

      await registry.connect(alice).burnPrana(ethers.parseEther("60"));
      const blk2 = await ethers.provider.getBlockNumber();

      // advance so the lookups are strictly in the past
      await ethers.provider.send("evm_mine", []);

      expect(await adapter.getVotes(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await adapter.getPastVotes(alice.address, blk1)).to.equal(ethers.parseEther("40"));
      expect(await adapter.getPastVotes(alice.address, blk2)).to.equal(ethers.parseEther("100"));
      // before any burn: zero
      expect(await adapter.getPastVotes(alice.address, blk1 - 1)).to.equal(0n);
    });

    it("getPastTotalSupply tracks the summed snapshotted weight historically", async () => {
      await registry.connect(alice).burnPrana(ethers.parseEther("10"));
      const a = await ethers.provider.getBlockNumber();
      await registry.connect(bob).burnPrana(ethers.parseEther("25"));
      const b = await ethers.provider.getBlockNumber();
      await ethers.provider.send("evm_mine", []);

      expect(await adapter.getPastTotalSupply(a)).to.equal(ethers.parseEther("10"));
      expect(await adapter.getPastTotalSupply(b)).to.equal(ethers.parseEther("35"));
    });

    it("manual checkpoint() catches up weight credited before the hook was wired", async () => {
      // Deploy a fresh registry with NO hook wired, then attach an adapter after a burn.
      const Reg = await ethers.getContractFactory("BurnStakeRegistry");
      const reg2 = await Reg.deploy(await prana.getAddress(), admin.address);
      await prana.connect(alice).approve(await reg2.getAddress(), ethers.MaxUint256);
      await reg2.connect(alice).burnPrana(ethers.parseEther("50")); // no hook ⇒ no auto-checkpoint

      const Adapter = await ethers.getContractFactory("BurnStakeGovernanceAdapter");
      const ad2 = await Adapter.deploy(await reg2.getAddress());

      expect(await ad2.getVotes(alice.address)).to.equal(0n); // not yet checkpointed
      await ad2.connect(alice).checkpoint(); // catch-up
      expect(await ad2.getVotes(alice.address)).to.equal(ethers.parseEther("50"));

      const blk = await ethers.provider.getBlockNumber();
      await ethers.provider.send("evm_mine", []);
      expect(await ad2.getPastVotes(alice.address, blk)).to.equal(ethers.parseEther("50"));
    });

    it("future-lookup reverts; delegation is inert (self-delegate, delegate() reverts)", async () => {
      const future = (await ethers.provider.getBlockNumber()) + 10;
      await expect(adapter.getPastVotes(alice.address, future)).to.be.revertedWithCustomError(
        adapter,
        "FutureLookup"
      );
      expect(await adapter.delegates(alice.address)).to.equal(alice.address);
      await expect(adapter.connect(alice).delegate(bob.address)).to.be.reverted;
    });

    it("onWeightCredited can only be called by the registry", async () => {
      await expect(
        adapter.connect(alice).onWeightCredited(alice.address, 1n, 1n)
      ).to.be.revertedWithCustomError(adapter, "NotRegistry");
    });
  });
});
