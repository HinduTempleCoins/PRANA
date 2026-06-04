const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// XX7 — Fee-mechanism invariant suite: SettlementFeeHook (PP1) + CountercyclicalFeeOracle (PP2) +
// HathorFeeTreasury (PP3).
//
// Encoded invariants:
//   (a) CONSERVATION: net + fee == gross, always (no value created/destroyed at settlement); the
//       treasury receives exactly `fee` and the payee receives exactly `net`, and the ledger's
//       balance drops by exactly `gross`.
//   (b) RATE BOUNDS: the oracle's currentRateBps() is within [floorBps, ceilingBps] for ALL inputs
//       (any price / epoch / machine-count, including absurd extremes) — the hard clamp can never be
//       escaped. fee == gross*rate/1e4 <= gross.
//   (c) TREASURY ONLY RECEIVES: HathorFeeTreasury exposes no trade/approve/swap surface; its ONLY
//       outflow is withdraw*(), gated to GOVERNOR_ROLE (the DAO timelock). It never moves funds itself.
//   (d) QUOTE == SETTLE: quote(amount) returns exactly the (fee, net) split that settle() actually
//       transfers (off-chain reads match on-chain settlement).
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

const e18 = (n) => ethers.parseEther(String(n));
const BPS_DENOM = 10000n;

// Any address used as the priced-token key for the oracle.
const PRANA_KEY = "0x000000000000000000000000000000000000dead";

const FLOOR = 10n;
const CEIL = 500n;
const PARAMS = {
  floorBps: Number(FLOOR),
  ceilingBps: Number(CEIL),
  steadyFloorBps: 10,
  steadyCeilBps: 300,
  bootstrapCeilBps: 500,
  machineThresholdX: 1000,
  refLowPrice: e18("1"),
  refHighPrice: e18("10"),
  bootstrapEpochs: 100,
};

describe("Fee mechanism — invariants (SettlementFeeHook + CountercyclicalFeeOracle + HathorFeeTreasury)", function () {
  async function deployFixture() {
    const [admin, ledger, payee, attacker, governor] = await ethers.getSigners();

    const Price = await ethers.getContractFactory("MockStaleOracle");
    const price = await Price.deploy();
    const Em = await ethers.getContractFactory("MockEmissionPhase");
    const emission = await Em.deploy();
    const Cnt = await ethers.getContractFactory("MockVerifiedCounter");
    const counter = await Cnt.deploy();

    const O = await ethers.getContractFactory("CountercyclicalFeeOracle");
    const oracle = await O.deploy(
      admin.address,
      await price.getAddress(),
      PRANA_KEY,
      await emission.getAddress(),
      await counter.getAddress(),
      PARAMS
    );

    const Tre = await ethers.getContractFactory("HathorFeeTreasury");
    const treasury = await Tre.deploy(admin.address, governor.address);

    const H = await ethers.getContractFactory("SettlementFeeHook");
    const hook = await H.deploy(
      admin.address,
      ledger.address,
      await treasury.getAddress(),
      await oracle.getAddress()
    );

    const M = await ethers.getContractFactory("MockERC20");
    const token = await M.deploy("Prana", "PRANA");
    await token.mint(ledger.address, e18("100000000"));
    await token.connect(ledger).approve(await hook.getAddress(), ethers.MaxUint256);

    return {
      admin,
      ledger,
      payee,
      attacker,
      governor,
      price,
      emission,
      counter,
      oracle,
      treasury,
      hook,
      token,
    };
  }

  async function setState({ price, emission, counter }, { p, epoch = 0, machines = 0 }) {
    await price.setPrice(PRANA_KEY, p);
    await emission.setEpoch(epoch);
    await counter.setCount(machines);
  }

  // ----------------------------------------------------------------------------------------------
  // (b) RATE BOUNDS — for ALL inputs, currentRateBps ∈ [floor, ceiling].
  // ----------------------------------------------------------------------------------------------
  it("(b) currentRateBps stays within [floorBps, ceilingBps] for ALL price/epoch/machine inputs", async () => {
    const fx = await loadFixture(deployFixture);
    const { oracle } = fx;
    const rng = makeRng(0xfee0c1);

    const extremePrices = [0n, 1n, e18("1"), e18("5.5"), e18("10"), e18("1000000"), ethers.MaxUint256];
    const extremeEpochs = [0, 1, 99, 100, 101, 1_000_000];
    const extremeMachines = [0n, 1n, 999n, 1000n, 1001n, ethers.MaxUint256];

    // Exhaust the curated extremes (band/phase/threshold corners).
    for (const p of extremePrices) {
      for (const epoch of extremeEpochs) {
        for (const machines of extremeMachines) {
          await setState(fx, { p, epoch, machines });
          const r = await oracle.currentRateBps();
          expect(r).to.be.gte(FLOOR);
          expect(r).to.be.lte(CEIL);
        }
      }
    }

    // Plus randomized fuzz across the full ranges.
    for (let i = 0; i < 150; i++) {
      const p = BigInt(Math.floor(rng() * 20)) * e18("1") + BigInt(Math.floor(rng() * 1e9));
      const epoch = Math.floor(rng() * 300);
      const machines = BigInt(Math.floor(rng() * 2500));
      await setState(fx, { p, epoch, machines });
      const r = await oracle.currentRateBps();
      expect(r).to.be.gte(FLOOR);
      expect(r).to.be.lte(CEIL);
    }
  });

  it("(b) a mis-set band (via setParams) can never push the output outside the floor/ceiling caps", async () => {
    const fx = await loadFixture(deployFixture);
    const { oracle, admin } = fx;
    // Re-point the curve so the steady band sits AT the ceiling; output must still clamp to [floor,ceil].
    const wide = { ...PARAMS, steadyCeilBps: 500, bootstrapCeilBps: 500 };
    await oracle.connect(admin).setParams(wide);
    for (const machines of [0n, 5000n]) {
      for (const p of [0n, e18("1"), e18("1000000")]) {
        await setState(fx, { p, epoch: 0, machines });
        const r = await oracle.currentRateBps();
        expect(r).to.be.gte(FLOOR);
        expect(r).to.be.lte(CEIL);
      }
    }
  });

  // ----------------------------------------------------------------------------------------------
  // (a)+(d) CONSERVATION and QUOTE==SETTLE — randomized over amounts and oracle states.
  // ----------------------------------------------------------------------------------------------
  it("(a)+(d) net + fee == gross, quote()==settle() split, balances move exactly, across randomized states", async () => {
    const fx = await loadFixture(deployFixture);
    const { hook, oracle, token, ledger, payee, treasury } = fx;
    const rng = makeRng(0xc0ffee);
    const tokenAddr = await token.getAddress();
    const treAddr = await treasury.getAddress();

    for (let i = 0; i < 120; i++) {
      // Vary the oracle state so the rate ranges across the whole band.
      const p = BigInt(Math.floor(rng() * 12)) * e18("1") + 1n;
      const epoch = Math.floor(rng() * 120);
      const machines = BigInt(Math.floor(rng() * 1500));
      await setState(fx, { p, epoch, machines });

      const rate = BigInt(await oracle.currentRateBps());
      // Mix tiny (dust → fee floors to 0) and large amounts.
      const gross = rng() < 0.25 ? BigInt(1 + Math.floor(rng() * 50)) : e18(1 + Math.floor(rng() * 5000));

      // (d) quote() is the source of truth for the split.
      const [qFee, qNet, qRate] = await hook.quote(gross);
      expect(qRate).to.equal(rate);
      expect(qFee).to.equal((gross * rate) / BPS_DENOM);

      // (a) Conservation in the quote: net + fee == gross, fee <= gross (rate <= 1e4).
      expect(qNet + qFee).to.equal(gross);
      expect(qFee).to.be.lte(gross);

      // settle() returns the same net the quote predicted.
      const retNet = await hook
        .connect(ledger)
        .settle.staticCall(tokenAddr, payee.address, gross);
      expect(retNet).to.equal(qNet);

      // Execute and verify on-chain balance deltas match the quote exactly.
      const payeeBefore = await token.balanceOf(payee.address);
      const treBefore = await token.balanceOf(treAddr);
      const ledgerBefore = await token.balanceOf(ledger.address);

      await hook.connect(ledger).settle(tokenAddr, payee.address, gross);

      const payeeDelta = (await token.balanceOf(payee.address)) - payeeBefore;
      const treDelta = (await token.balanceOf(treAddr)) - treBefore;
      const ledgerDelta = ledgerBefore - (await token.balanceOf(ledger.address));

      // (d) the actual split == the quoted split.
      expect(payeeDelta).to.equal(qNet);
      expect(treDelta).to.equal(qFee);
      // (a) value is conserved end-to-end: what left the ledger == net + fee == gross.
      expect(ledgerDelta).to.equal(gross);
      expect(payeeDelta + treDelta).to.equal(gross);
    }
  });

  it("(a) dust path: when fee floors to 0, the full gross goes to the payee and the treasury is untouched", async () => {
    const fx = await loadFixture(deployFixture);
    const { hook, token, ledger, payee, treasury } = fx;
    await setState(fx, { p: e18("10") }); // steady floor 0.1%
    const tokenAddr = await token.getAddress();
    const treAddr = await treasury.getAddress();

    const gross = 100n; // 0.1% of 100 floors to 0
    const [fee, net] = await hook.quote(gross);
    expect(fee).to.equal(0n);
    expect(net).to.equal(gross);

    const treBefore = await token.balanceOf(treAddr);
    await hook.connect(ledger).settle(tokenAddr, payee.address, gross);
    expect(await token.balanceOf(treAddr)).to.equal(treBefore); // untouched
    expect(await token.balanceOf(payee.address)).to.equal(gross);
  });

  // ----------------------------------------------------------------------------------------------
  // (c) TREASURY ONLY RECEIVES.
  // ----------------------------------------------------------------------------------------------
  it("(c) HathorFeeTreasury exposes no trade/approve/swap surface — only governance withdrawals out", async () => {
    const { treasury } = await loadFixture(deployFixture);
    const fnNames = treasury.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());

    // No market/trade surface at all.
    for (const banned of ["approve", "swap", "trade", "buy", "sell", "exchange", "route", "deposit"]) {
      expect(
        fnNames.some((n) => n.includes(banned)),
        `treasury must not expose "${banned}"`
      ).to.equal(false);
    }
    // The ONLY outflow functions are the two governance withdrawals.
    const outflows = fnNames.filter((n) => n.includes("withdraw"));
    expect(outflows.sort()).to.deep.equal(["withdrawerc20", "withdrawnative"]);
  });

  it("(c) treasury outflow is GOVERNOR_ROLE-gated; the fee hook (a depositor) cannot pull funds back out", async () => {
    const fx = await loadFixture(deployFixture);
    const { hook, oracle, token, ledger, payee, treasury, governor, attacker, admin } = fx;
    await setState(fx, { p: e18("1") }); // 5%
    const tokenAddr = await token.getAddress();
    const treAddr = await treasury.getAddress();

    // Fund the treasury via a real settlement.
    await hook.connect(ledger).settle(tokenAddr, payee.address, e18("100"));
    const held = await token.balanceOf(treAddr);
    expect(held).to.equal(e18("5"));

    // Non-governor (attacker, admin-without-governor-role) cannot withdraw.
    await expect(
      treasury.connect(attacker).withdrawERC20(tokenAddr, attacker.address, held)
    ).to.be.reverted;
    await expect(
      treasury.connect(admin).withdrawERC20(tokenAddr, admin.address, held)
    ).to.be.reverted;

    // Only the DAO timelock (GOVERNOR_ROLE) can disburse — and only via the explicit path.
    await expect(treasury.connect(governor).withdrawERC20(tokenAddr, governor.address, held))
      .to.emit(treasury, "WithdrawnERC20")
      .withArgs(tokenAddr, governor.address, held);
    expect(await token.balanceOf(treAddr)).to.equal(0n);
  });

  it("(c) treasury accumulates fees monotonically across many settlements (only receives until governance pulls)", async () => {
    const fx = await loadFixture(deployFixture);
    const { hook, oracle, token, ledger, payee, treasury } = fx;
    const rng = makeRng(0x7ea5);
    const tokenAddr = await token.getAddress();
    const treAddr = await treasury.getAddress();

    let expected = 0n;
    let prev = await token.balanceOf(treAddr);
    for (let i = 0; i < 60; i++) {
      const p = BigInt(Math.floor(rng() * 12)) * e18("1") + 1n;
      await setState(fx, { p, epoch: 0, machines: 0 });
      const gross = e18(1 + Math.floor(rng() * 1000));
      const [fee] = await hook.quote(gross);

      await hook.connect(ledger).settle(tokenAddr, payee.address, gross);
      expected += fee;

      const bal = await token.balanceOf(treAddr);
      expect(bal).to.equal(expected);
      expect(bal).to.be.gte(prev); // never decreases on its own
      prev = bal;
    }
  });

  it("(a)+(d) settle() is LEDGER_ROLE-gated — a non-ledger caller cannot trigger a skim", async () => {
    const fx = await loadFixture(deployFixture);
    const { hook, token, payee, attacker } = fx;
    await setState(fx, { p: e18("1") });
    await expect(
      hook.connect(attacker).settle(await token.getAddress(), payee.address, e18("100"))
    ).to.be.reverted;
  });
});
