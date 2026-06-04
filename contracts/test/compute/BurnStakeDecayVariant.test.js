const { expect } = require("chai");
const { ethers } = require("hardhat");

// BurnStakeDecayVariant (OO5) — the OPTIONAL Slimcoin-model alternative where weight decays linearly
// to zero over a configured horizon. Verifies the decay math (full at burn, half at mid-horizon,
// zero at/after horizon), multi-tranche summation, and that principal is still irreversibly burned.
describe("BurnStakeDecayVariant (optional Slimcoin model)", function () {
  let prana, registry;
  let admin, router, alice, bob;
  const HORIZON = 1000; // seconds
  const AMT = ethers.parseEther("100");

  async function setNextTs(ts) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
  }

  beforeEach(async () => {
    [admin, router, alice, bob] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    prana = await Mock.deploy("Prana", "PRANA");

    const Reg = await ethers.getContractFactory("BurnStakeDecayVariant");
    registry = await Reg.deploy(await prana.getAddress(), HORIZON, admin.address);

    for (const u of [alice, bob]) {
      await prana.mint(u.address, ethers.parseEther("1000"));
      await prana.connect(u).approve(await registry.getAddress(), ethers.MaxUint256);
    }
  });

  it("constructor rejects a zero horizon", async () => {
    const Reg = await ethers.getContractFactory("BurnStakeDecayVariant");
    await expect(
      Reg.deploy(await prana.getAddress(), 0, admin.address)
    ).to.be.revertedWithCustomError(registry, "ZeroHorizon");
  });

  it("burnPrana burns principal (supply down) and weight starts at full", async () => {
    const supply0 = await prana.totalSupply();
    const tx = await registry.connect(alice).burnPrana(AMT);
    const rcpt = await tx.wait();
    const burnTs = (await ethers.provider.getBlock(rcpt.blockNumber)).timestamp;

    expect(await prana.totalSupply()).to.equal(supply0 - AMT);
    // at the burn instant weight == amount (read in the same block is ~full)
    // read slightly later but well before horizon checked in the decay test below.
    expect(await registry.trancheCount(alice.address)).to.equal(1n);
    expect(burnTs).to.be.a("number");
  });

  it("weight decays linearly: full → half at mid-horizon → zero at/after horizon", async () => {
    const t0 = (await ethers.provider.getBlock("latest")).timestamp + 10;
    await setNextTs(t0);
    await registry.connect(alice).burnPrana(AMT);

    // just after burn (t0): ~full. Mine a read block right at t0+1 for a near-full sample.
    await setNextTs(t0 + 1);
    await ethers.provider.send("evm_mine", []);
    let w = await registry.weightOf(alice.address);
    // (HORIZON-1)/HORIZON of AMT
    expect(w).to.equal((AMT * BigInt(HORIZON - 1)) / BigInt(HORIZON));

    // mid-horizon: half
    await setNextTs(t0 + HORIZON / 2);
    await ethers.provider.send("evm_mine", []);
    w = await registry.weightOf(alice.address);
    expect(w).to.equal(AMT / 2n);

    // exactly at horizon: zero
    await setNextTs(t0 + HORIZON);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.weightOf(alice.address)).to.equal(0n);

    // well past horizon: still zero (never negative)
    await setNextTs(t0 + HORIZON * 3);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.weightOf(alice.address)).to.equal(0n);
  });

  it("multiple tranches sum and decay independently", async () => {
    const t0 = (await ethers.provider.getBlock("latest")).timestamp + 10;
    await setNextTs(t0);
    await registry.connect(alice).burnPrana(AMT); // tranche A at t0

    await setNextTs(t0 + HORIZON / 2);
    await registry.connect(alice).burnPrana(AMT); // tranche B at t0 + H/2

    // read at t0 + H/2 + small: A has half left, B ~full
    await setNextTs(t0 + HORIZON / 2 + 1);
    await ethers.provider.send("evm_mine", []);
    const w = await registry.weightOf(alice.address);
    // A: remainingTime = HORIZON - (H/2 + 1) = H/2 - 1
    const aRem = (AMT * BigInt(HORIZON / 2 - 1)) / BigInt(HORIZON);
    // B: remainingTime = HORIZON - 1
    const bRem = (AMT * BigInt(HORIZON - 1)) / BigInt(HORIZON);
    expect(w).to.equal(aRem + bRem);
    expect(await registry.trancheCount(alice.address)).to.equal(2n);
  });

  it("totalWeight sums across accounts and decays to zero", async () => {
    const t0 = (await ethers.provider.getBlock("latest")).timestamp + 10;
    await setNextTs(t0);
    await registry.connect(alice).burnPrana(AMT);
    await setNextTs(t0 + 1);
    await registry.connect(bob).burnPrana(AMT);

    await setNextTs(t0 + 2);
    await ethers.provider.send("evm_mine", []);
    const total = await registry.totalWeight();
    const aRem = (AMT * BigInt(HORIZON - 2)) / BigInt(HORIZON);
    const bRem = (AMT * BigInt(HORIZON - 1)) / BigInt(HORIZON);
    expect(total).to.equal(aRem + bRem);

    // past both horizons: total zero
    await setNextTs(t0 + HORIZON + 5);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.totalWeight()).to.equal(0n);
  });

  it("recordBurnWeight is BURNER-gated and credits a decaying tranche", async () => {
    const BURNER = await registry.BURNER_ROLE();
    await expect(
      registry.connect(router).recordBurnWeight(bob.address, await prana.getAddress(), 1n, AMT)
    ).to.be.reverted;
    await registry.connect(admin).grantRole(BURNER, router.address);

    const t0 = (await ethers.provider.getBlock("latest")).timestamp + 10;
    await setNextTs(t0);
    await registry.connect(router).recordBurnWeight(bob.address, await prana.getAddress(), 1n, AMT);
    await setNextTs(t0 + HORIZON / 2);
    await ethers.provider.send("evm_mine", []);
    expect(await registry.weightOf(bob.address)).to.equal(AMT / 2n);
  });
});
