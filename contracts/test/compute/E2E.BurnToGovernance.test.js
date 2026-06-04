const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// XX10 — burn -> perma-weight -> BOTH emission AND governance, from ONE burn.
//
// Wires the REAL stack:
//   MultiCurrencyBurnRouter --burn--> BurnStakeRegistry (perma, non-withdrawable weight)
//   BurnStakeRegistry --weightHook--> BurnStakeGovernanceAdapter (IVotes, block-stamped history)
//   BurnStakeRegistry.weightOf --> UnifiedSharesLedger BURN lane (emission via BURN_CREDITOR)
//
// Proves from a SINGLE burn:
//   (1) burning via the router raises the user's registry weight by the normalized amount,
//   (2) that weight credits the ledger's BURN lane -> the user earns emission (PRANA payout),
//   (3) that SAME weight drives the governance adapter's IVotes (getVotes / getPastVotes),
//   (4) the weight is PERMANENT and non-withdrawable (no exit path; weight only ever rises).

// Lane enum: HASH=0, TASK=1, BURN=2
const BURN = 2;
const ONE = 10n ** 18n;

const EPOCH_LEN = 3600n;
const WINDOW = 1n;
const ISSUANCE = 1000n * ONE;

let BASE = 1_000_000n; // re-anchored in deploy() above the live global clock (sibling suites advance it)
const ep = (n) => BASE + BigInt(n);

describe("E2E burn -> weight -> emission + governance (XX10)", function () {
  async function deploy() {
    BASE = BigInt(await time.latest()) / EPOCH_LEN + 100n;
    const [admin, alice, burnLaneKeeper] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const prana = await Mock.deploy("Prana", "PRANA"); // ERC20Burnable

    // --- weight config + ledger ---
    const Cfg = await ethers.getContractFactory("HashTaskWeightConfig");
    // BURN weight = 1e18 (1x) so burned weight pools 1:1 into the BURN lane.
    const cfg = await Cfg.deploy(admin.address, ONE, 1n, 1_000_000n);

    const Ledger = await ethers.getContractFactory("UnifiedSharesLedger");
    const ledger = await Ledger.deploy(
      await prana.getAddress(),
      await cfg.getAddress(),
      admin.address,
      EPOCH_LEN,
      WINDOW,
      ISSUANCE
    );

    // --- burn-stake registry (perma-weight) ---
    const Registry = await ethers.getContractFactory("BurnStakeRegistry");
    const registry = await Registry.deploy(await prana.getAddress(), admin.address);

    // --- governance adapter wired as the registry's auto-checkpoint hook ---
    const Adapter = await ethers.getContractFactory("BurnStakeGovernanceAdapter");
    const adapter = await Adapter.deploy(await registry.getAddress());
    await registry.connect(admin).setWeightHook(await adapter.getAddress());

    // --- price source + burn router ---
    const Price = await ethers.getContractFactory("FixedRatioPriceSource");
    const priceSource = await Price.deploy(admin.address);

    const Router = await ethers.getContractFactory("MultiCurrencyBurnRouter");
    const router = await Router.deploy(admin.address, await registry.getAddress(), await priceSource.getAddress());

    // router must hold BURNER_ROLE to record weight into the registry.
    await registry.grantRole(await registry.BURNER_ROLE(), await router.getAddress());

    // price PRANA at parity (1 PRANA burned -> 1 weight) and allowlist it as a wrapped/ERC20 path.
    // NOTE: NATIVE is the sentinel address(0); we burn PRANA as an allowlisted ERC20Burnable so the
    // router does a real supply-reducing burn() (a true sink), exercising the wrapped path.
    await priceSource.connect(admin).setRatio(await prana.getAddress(), ONE);
    await router.connect(admin).setCurrencyAllowed(await prana.getAddress(), true);

    // --- ledger BURN-lane crediting role (the emission keeper reads registry weight and credits) ---
    await ledger.grantRole(await ledger.BURN_CREDITOR(), burnLaneKeeper.address);
    await ledger.grantRole(await ledger.FUNDER_ROLE(), admin.address);
    await prana.mint(admin.address, 1_000_000n * ONE);
    await prana.connect(admin).approve(await ledger.getAddress(), ethers.MaxUint256);
    await ledger.connect(admin).fundEpoch(100_000n * ONE);

    return { admin, alice, burnLaneKeeper, prana, cfg, ledger, registry, adapter, priceSource, router };
  }

  async function gotoEpoch(target) {
    const want = ep(target);
    const now = BigInt(await time.latest());
    const cur = now / EPOCH_LEN;
    if (want > cur) {
      await time.setNextBlockTimestamp(Number(want * EPOCH_LEN));
      await ethers.provider.send("evm_mine", []);
    }
  }

  it("one burn raises perma-weight, drives BURN-lane emission AND IVotes governance", async () => {
    const { admin, alice, burnLaneKeeper, prana, ledger, registry, adapter, router } = await loadFixture(deploy);

    const burnAmt = 500n * ONE;
    await prana.mint(alice.address, burnAmt);
    await prana.connect(alice).approve(await router.getAddress(), burnAmt);

    await gotoEpoch(10);
    const e = ep(10);

    // ---- THE BURN ----
    const supplyBefore = await prana.totalSupply();
    await expect(router.connect(alice).burnToMine(await prana.getAddress(), burnAmt))
      .to.emit(router, "BurnedToMine");

    // (1) registry weight rose by the normalized amount (1:1 ratio -> == burnAmt).
    expect(await registry.weightOf(alice.address)).to.equal(burnAmt);
    expect(await registry.totalWeight()).to.equal(burnAmt);
    // the principal was truly burned (totalSupply dropped) — a real sink.
    expect(await prana.totalSupply()).to.equal(supplyBefore - burnAmt);

    // (3) governance: the auto-checkpoint hook recorded the weight at the burn block as IVotes.
    expect(await adapter.getVotes(alice.address)).to.equal(burnAmt);

    // (2) emission: an emission keeper credits the registry weight into the ledger's BURN lane.
    await ledger.connect(burnLaneKeeper).creditShares(alice.address, BURN, await registry.weightOf(alice.address));
    expect(await ledger.poolShares(e, alice.address)).to.equal(burnAmt); // 1x BURN weight

    // close the epoch -> sole BURN-lane worker earns the full issuance.
    await gotoEpoch(11);
    expect(await ledger.claimable(alice.address, e)).to.equal(ISSUANCE);
    const balBefore = await prana.balanceOf(alice.address);
    await ledger.connect(alice).claim(e);
    expect((await prana.balanceOf(alice.address)) - balBefore).to.equal(ISSUANCE);

    // (3b) governance history is queryable at a past block (getPastVotes).
    const burnBlock = BigInt(await time.latestBlock());
    await ethers.provider.send("evm_mine", []); // advance one block so burnBlock is strictly past
    expect(await adapter.getPastVotes(alice.address, burnBlock)).to.equal(burnAmt);
    expect(await adapter.getPastTotalSupply(burnBlock)).to.equal(burnAmt);
  });

  it("weight is PERMANENT and non-withdrawable — no exit path, only grows", async () => {
    const { alice, prana, registry, adapter, router } = await loadFixture(deploy);

    const burn1 = 200n * ONE;
    const burn2 = 300n * ONE;
    await prana.mint(alice.address, burn1 + burn2);
    await prana.connect(alice).approve(await router.getAddress(), burn1 + burn2);

    await router.connect(alice).burnToMine(await prana.getAddress(), burn1);
    expect(await registry.weightOf(alice.address)).to.equal(burn1);

    // A second burn only ADDS — weight is monotonic non-decreasing.
    await router.connect(alice).burnToMine(await prana.getAddress(), burn2);
    expect(await registry.weightOf(alice.address)).to.equal(burn1 + burn2);
    expect(await registry.totalWeight()).to.equal(burn1 + burn2);

    // There is NO function on the registry that reduces weight or returns principal.
    const fnNames = registry.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const f of ["withdraw", "unstake", "unlock", "redeem", "refund", "exit", "decreaseWeight", "slash"]) {
      expect(fnNames, `BurnStakeRegistry must not expose ${f}()`).to.not.include(f);
    }

    // adapter weight tracks the (only-growing) registry weight after the second burn too.
    expect(await adapter.getVotes(alice.address)).to.equal(burn1 + burn2);
  });

  it("burn-stake governance cannot be delegated (bound to the burner)", async () => {
    const { adapter } = await loadFixture(deploy);
    await expect(adapter.delegate(ethers.ZeroAddress)).to.be.revertedWith("burn-stake: no delegation");
  });
});
